import { workflow, node, trigger } from '@n8n/workflow-sdk';

const n_every_minute = trigger({
  "type": "n8n-nodes-base.scheduleTrigger",
  "version": 1.2,
  "config": {
    "name": "every minute",
    "parameters": {
      "rule": {
        "interval": [
          {
            "field": "minutes",
            "minutesInterval": 1
          }
        ]
      }
    },
    "position": [
      0,
      300
    ]
  }
});

const n_mint_claim_id = node({
  "type": "n8n-nodes-base.code",
  "version": 2,
  "config": {
    "name": "mint claim id",
    "parameters": {
      "jsCode": "// One id per run, read by every later node through $('mint claim id') -- one\n// source, so the claim and the settle can never disagree about which run they are.\nreturn [{ json: { claim_id: 'img-' + $execution.id + '-' + Date.now() } }];\n"
    },
    "position": [
      220,
      300
    ]
  }
});

const n_claim_images = node({
  "type": "n8n-nodes-base.postgres",
  "version": 2.7,
  "config": {
    "name": "claim images",
    "parameters": {
      "operation": "executeQuery",
      "query": "-- At most 2 images: the free tier's per-minute budget. product_vectors.sql explains the order.\nSELECT * FROM product_image_claim(p_claim_id => $1, p_max_images => $2::int);",
      "options": {
        "queryReplacement": "={{ [ $json.claim_id, 2 ] }}"
      }
    },
    "position": [
      440,
      300
    ],
    "credentials": {
      "postgres": {
        "id": "ZsOTxlRX7LiLABjX",
        "name": "Postgres account"
      }
    }
  }
});

const n_build_embed_request = node({
  "type": "n8n-nodes-base.code",
  "version": 2,
  "config": {
    "name": "build embed request",
    "parameters": {
      "jsCode": "// ── build embed request ─────────────────────────────────────────────────────\n// Code node, \"Run Once for All Items\". Input: the rows product_image_claim()\n// returned (0 rows never reaches here -- the Postgres node emits nothing and the\n// run ends). Output: ONE item carrying the claim and the Voyage request body.\n//\n// The image goes to Voyage as its URL, and Voyage fetches it. The bytes never\n// pass through n8n, which keeps this workflow's memory flat however large the\n// photos are. The cost of that choice: the URL must be reachable from the public\n// internet -- true of the R2 CDN in production, never true of a dev laptop's\n// storage (which is why `build all texts` only lists https URLs).\n//\n// input_type 'document' -- the search side embeds with 'query'. Voyage's\n// embeddings are asymmetric; see README § 11.\n\nconst claimId = $('mint claim id').first().json.claim_id;\nconst rows = $input.all()\n  .map(i => i.json)\n  .filter(r => r && r.product_id && r.file_id && r.image_url);\n\nif (rows.length === 0) {\n  // The claim returned rows the filter above refused. Nothing to embed, and\n  // nothing to settle: those rows stay 'claimed' and the claim function's stale\n  // recovery returns them in 10 minutes, counted as an attempt.\n  return [];\n}\n\nreturn [{\n  json: {\n    claim_id: claimId,\n    rows: rows.map(r => ({\n      product_id: String(r.product_id),\n      file_id: String(r.file_id),\n      image_url: String(r.image_url),\n      attempts: Number(r.attempts) || 0,\n    })),\n    body: {\n      model: 'voyage-multimodal-3.5',\n      input_type: 'document',\n      inputs: rows.map(r => ({ content: [{ type: 'image_url', image_url: String(r.image_url) }] })),\n    },\n  },\n}];\n"
    },
    "position": [
      660,
      300
    ]
  }
});

const n_embed_images = node({
  "type": "n8n-nodes-base.httpRequest",
  "version": 4.5,
  "config": {
    "name": "embed images",
    "parameters": {
      "method": "POST",
      "url": "https://api.voyageai.com/v1/multimodalembeddings",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpHeaderAuth",
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify($json.body) }}",
      "options": {
        "response": {
          "response": {
            "fullResponse": true,
            "neverError": true
          }
        },
        "timeout": 60000
      }
    },
    "position": [
      880,
      300
    ],
    "credentials": {
      "httpHeaderAuth": {
        "id": "aIUCGerxuUIrWTtO",
        "name": "Voyage Bearer"
      }
    },
    "onError": "continueRegularOutput"
  }
});

const n_assemble_results = node({
  "type": "n8n-nodes-base.code",
  "version": 2,
  "config": {
    "name": "assemble results",
    "parameters": {
      "jsCode": "// ── assemble results ────────────────────────────────────────────────────────\n// Code node, \"Run Once for All Items\". Turns Voyage's answer into one settle\n// payload: an outcome for EVERY claimed row, never fewer -- a row left out of\n// the settle stays 'claimed' until stale recovery, and that costs it an attempt\n// it did not deserve.\n//\n// `embed images` runs with neverError + fullResponse, and onError\n// continueRegularOutput, so this node always receives exactly one item:\n//   { statusCode, headers, body }   an HTTP answer, whatever its status\n//   { error }                       no HTTP answer at all (DNS, timeout, reset)\n//\n// ⚠ WHOSE FAULT IT WAS DECIDES THE OUTCOME, because only 'failed' spends an\n// attempt (product_image_settle):\n//   200                       → embedded, per row, after the count + dimension guards\n//   400 / 413 / 415 / 422     → failed   -- the request carried something Voyage\n//                                refused, and the only variable part is the images\n//   429                       → deferred -- the free tier's 3 RPM / 10K TPM\n//   401 / 403 / 5xx / other   → deferred, AND an alarm: nothing is lost, but a\n//                                refused credential or an outage is a human's job\n//   no answer                 → deferred, AND an alarm\n//\n// ⚠ A batch that fails with a 400 fails EVERY image in it, including the good\n// ones: Voyage rejects the request, not the input. That is why the claim takes\n// retries one at a time -- the second attempt of each image is alone, and only\n// the bad one keeps failing.\n\nconst EXPECTED_DIMS = 1024;           // vector(1024) in product_image_vectors\nconst IMAGE_FAULT = new Set([400, 413, 415, 422]);\n\nconst req = $('build embed request').first().json;\nconst { claim_id, rows } = req;\nconst res = $input.first().json || {};\n\nconst describe = (body) => {\n  if (body == null) return '';\n  if (typeof body === 'string') return body.slice(0, 500);\n  return String(body.detail ?? body.error?.message ?? body.message ?? JSON.stringify(body)).slice(0, 500);\n};\nconst everyRow = (outcome, error) => rows.map(r => ({ product_id: r.product_id, file_id: r.file_id, outcome, error }));\n\nlet results;\nlet alarm = null;\nconst status = Number(res.statusCode) || 0;\n\nif (!status) {\n  const why = res.error?.message ?? res.error ?? 'no response';\n  results = everyRow('deferred', `transport: ${String(why).slice(0, 300)}`);\n  alarm = `Voyage unreachable: ${String(why).slice(0, 300)}`;\n} else if (status === 429) {\n  results = everyRow('deferred', `429: ${describe(res.body)}`);\n} else if (IMAGE_FAULT.has(status)) {\n  results = everyRow('failed', `${status}: ${describe(res.body)}`);\n} else if (status !== 200) {\n  results = everyRow('deferred', `${status}: ${describe(res.body)}`);\n  alarm = `Voyage answered ${status}: ${describe(res.body)}`;\n} else {\n  const data = Array.isArray(res.body?.data) ? res.body.data.slice().sort((a, b) => a.index - b.index) : [];\n  if (data.length !== rows.length) {\n    // Never pair by position on a mismatch: a vector attached to the wrong image\n    // makes a product findable by somebody else's photo. README § 11's rule.\n    results = everyRow('failed', `Voyage returned ${data.length} embeddings for ${rows.length} images`);\n  } else {\n    // image_pixels is per REQUEST. Exact for a one-image request; for more, the\n    // split between images is unknown and a guessed split is worse than none.\n    const pixels = rows.length === 1 ? Number(res.body?.usage?.image_pixels) || null : null;\n    results = rows.map((r, i) => {\n      const e = data[i]?.embedding;\n      const ok = Array.isArray(e) && e.length === EXPECTED_DIMS && e.every(Number.isFinite);\n      return ok\n        ? { product_id: r.product_id, file_id: r.file_id, outcome: 'embedded', embedding: e, image_pixels: pixels }\n        : { product_id: r.product_id, file_id: r.file_id, outcome: 'failed',\n            error: `embedding malformed: ${Array.isArray(e) ? e.length + ' dims' : typeof e}` };\n    });\n  }\n}\n\nreturn [{\n  json: {\n    claim_id,\n    status,\n    alarm,\n    tokens: Number(res.body?.usage?.total_tokens) || null,\n    results,\n  },\n}];\n"
    },
    "position": [
      1100,
      300
    ]
  }
});

const n_settle_images = node({
  "type": "n8n-nodes-base.postgres",
  "version": 2.7,
  "config": {
    "name": "settle images",
    "parameters": {
      "operation": "executeQuery",
      "query": "SELECT * FROM product_image_settle(p_claim_id => $1, p_results => $2::jsonb);",
      "options": {
        "queryReplacement": "={{ [ $json.claim_id, JSON.stringify($json.results) ] }}"
      }
    },
    "position": [
      1320,
      300
    ],
    "credentials": {
      "postgres": {
        "id": "ZsOTxlRX7LiLABjX",
        "name": "Postgres account"
      }
    },
    "alwaysOutputData": true
  }
});

const n_verify_settled = node({
  "type": "n8n-nodes-base.code",
  "version": 2,
  "config": {
    "name": "verify settled",
    "parameters": {
      "jsCode": "// ── verify settled ──────────────────────────────────────────────────────────\n// Code node, \"Run Once for All Items\". Input: the rows product_image_settle()\n// RETURNED. `settle images` has alwaysOutputData on, so zero rows still arrives\n// here as one empty item -- which is the case this node exists to catch.\n//\n// Verify the ROW, never the node (README § 10): the Postgres node reporting\n// success means the statement ran, not that it wrote anything.\n//\n// It THROWS in two situations, so the run lands on the automation failure board\n// through this workflow's errorWorkflow:\n//   · fewer rows written than outcomes sent. Either the claim went stale (the run\n//     took over 10 minutes and another run re-took the images) or a re-index\n//     removed an image mid-flight. The second is harmless; the first is not, and\n//     from here the two cannot be told apart.\n//   · an alarm from `assemble results`: a refused credential, a Voyage outage, or\n//     no answer at all. Nothing was lost -- the images were deferred, not failed --\n//     but it will not fix itself.\n// A 429 does NOT throw. On the free tier it is weather, not an incident.\n\nconst sent = $('assemble results').first().json;\nconst written = $input.all().map(i => i.json).filter(r => r && r.product_id && r.file_id);\n\nconst count = (status) => written.filter(r => r.status === status).length;\nconst summary = {\n  claim_id: sent.claim_id,\n  voyage_status: sent.status,\n  tokens: sent.tokens,\n  sent: sent.results.length,\n  written: written.length,\n  embedded: count('embedded'),\n  failed: count('failed'),\n  deferred: count('pending'),\n};\n\nif (written.length !== sent.results.length) {\n  throw new Error(\n    `image vectoriser: settled ${written.length} of ${sent.results.length} images for claim ${sent.claim_id}. ` +\n    'Either the claim went stale (this run took longer than the 10-minute claim window) or a re-index ' +\n    'removed the image meanwhile (harmless). ' + JSON.stringify(summary),\n  );\n}\nif (sent.alarm) {\n  throw new Error(`image vectoriser: ${sent.alarm} -- ${summary.deferred} image(s) deferred, none lost. ` + JSON.stringify(summary));\n}\n\nreturn [{ json: summary }];\n"
    },
    "position": [
      1540,
      300
    ]
  }
});

export default workflow('wi-mall-image-vectoriser', "UP-wi-mall-image-vectoriser")
  .add(n_every_minute)
  .to(n_mint_claim_id)
  .to(n_claim_images)
  .to(n_build_embed_request)
  .to(n_embed_images)
  .to(n_assemble_results)
  .to(n_settle_images)
  .to(n_verify_settled);
