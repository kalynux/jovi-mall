import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PolygonSchema, IPolygon } from '../../../core/types/geo.types';
import { AGENT_CONFIG } from '../config/agent.config';

/**
 * AgentAgencyContract — the negotiated relationship between one agent and one
 * agency.
 *
 * This is a CONTRACT, not a membership flag: it carries negotiated terms (COD
 * threshold, remittance cadence, fee split, coverage, value ceiling) that the
 * two parties agree before work starts, and a lifecycle in which either side
 * can propose a change the other must clear.
 *
 * Multi-agency is the whole point: an agent may hold several contracts at once,
 * and everything that differs per agency lives here rather than on the agent.
 * The rule for any new field: if the value could differ per agency, it belongs
 * here.
 *
 * ── The COD threshold is a sub-allocation, not an independent limit ──────────
 *
 * `cod.threshold` is a slice of the agent's own `cod.max_threshold` pool. The
 * sum of thresholds across an agent's ALLOCATING contracts may never exceed
 * that pool. See ALLOCATING_CONTRACT_STATUSES below and
 * AgentCodThresholdService for the enforcement.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────
 *
 *   pending ──approve──> active <──reactivate── paused
 *      │                  │  │                    ▲
 *      │                  │  └────pause/suspend───┘
 *      │                  │                   suspended
 *      └──reject──> rejected                       │
 *                         └──deactivate──> deactivated <──┘
 *
 * `approved` is an ACTION, not a resting state — approving a pending contract
 * lands it in `active`. The history event is named `approved`; the status is
 * `active`. Carrying both as statuses would leave a contract sitting "approved
 * but not active" with nothing to move it.
 */

export type ContractStatus =
  | 'pending'
  | 'rejected'
  | 'active'
  | 'paused'
  | 'suspended'
  | 'deactivated';

/**
 * Statuses that CONSUME the agent's COD threshold pool.
 *
 * The rule from the spec: a contract occupies its slice once it has had at
 * least one interaction and is not terminated. So:
 *
 *  - `pending`     — excluded. Never approved; no interaction has occurred.
 *  - `rejected`    — excluded. Terminal, never started.
 *  - `active`      — included, obviously.
 *  - `paused`      — INCLUDED. Pausing does not free capacity: the agent may
 *                    still be holding this agency's cash.
 *  - `suspended`   — INCLUDED, same reasoning.
 *  - `deactivated` — excluded. Termination is blocked while any COD is
 *                    outstanding, so a deactivated contract necessarily holds
 *                    zero cash and contributes nothing.
 *
 * A consequence worth stating: because paused/suspended contracts never leave
 * the sum, reactivating one can never fail a headroom check — it never gave
 * its slice back.
 */
export const ALLOCATING_CONTRACT_STATUSES: ContractStatus[] = ['active', 'paused', 'suspended'];

/** Statuses where the contract still exists as a live relationship. */
export const LIVE_CONTRACT_STATUSES: ContractStatus[] = ['pending', 'active', 'paused', 'suspended'];

/** Statuses that count toward the agent's max-relationships cap. */
export const COUNTED_CONTRACT_STATUSES: ContractStatus[] = ALLOCATING_CONTRACT_STATUSES;

/** Backwards-compatible alias — several call sites still speak "membership". */
export type MembershipStatus = ContractStatus;
export const LIVE_MEMBERSHIP_STATUSES = LIVE_CONTRACT_STATUSES;

export type EmploymentType = 'employee' | 'contractor' | 'freelancer';

/** How the contract began — kept for audit and analytics. */
export type ContractOrigin = 'invitation' | 'join_request' | 'transfer' | 'admin' | 'migration';
export type MembershipOrigin = ContractOrigin;

/**
 * How often the agent must settle collected COD cash with this agency.
 *
 * This is the mechanism by which `cod.outstanding_balance` returns to zero —
 * without a defined cadence, allocated headroom has no release path and an
 * agent's pool would silently fill up forever.
 */
export type RemittanceCadence = 'per_delivery' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'on_demand';

export interface IContractRemittanceTerms {
  cadence: RemittanceCadence;
  /** For weekly/biweekly: 0=Sunday … 6=Saturday. null for other cadences. */
  day_of_week: number | null;
  /** For monthly: 1–28 (28 to avoid short-month ambiguity). */
  day_of_month: number | null;
  /** Grace period before a settlement counts as late (feeds the trust signal). */
  grace_hours: number;
}

export interface IMembershipEmployment {
  employment_type: EmploymentType;
  /** The agency's own internal reference for this agent (staff number etc). */
  employee_ref: string | null;
  started_at: Date | null;
  /** Contract end for fixed-term engagements. null = open-ended. */
  ends_at: Date | null;
}

export interface IContractCod {
  /**
   * This agency's slice of the agent's global COD pool (minor units).
   * Bounded twice: by AGENT_CONFIG.CONTRACT_COD_THRESHOLD_{MIN,MAX} absolutely,
   * and by the agent's remaining headroom relatively.
   */
  threshold: number;
  /**
   * Cash the agent currently holds that is attributable to THIS agency.
   * Increased when a COD collection is recorded under this contract, decreased
   * by settlements. Blocks deactivation while > 0 — scoped to this contract,
   * not the agent's global pot, so leaving agency A is not blocked by cash the
   * agent owes agency B.
   */
  outstanding_balance: number;
  /** Lifetime cash settled cleanly under this contract — a trust signal. */
  lifetime_settled: number;
  last_settled_at: Date | null;
}

export interface IContractPayment {
  /**
   * What this agency still owes the agent for work performed under this
   * contract. Mirrors the agent's earnings account balance, scoped per contract
   * so §4's termination gate can be evaluated per relationship.
   */
  outstanding_to_agent: number;
  lifetime_paid: number;
  last_paid_at: Date | null;
}

/**
 * The commission arrangement. Varies by agency, so it lives on the contract
 * rather than the agent.
 */
export interface IContractFeeSplit {
  /** 'percentage' — agent_share_percent of the delivery fee; 'flat' — fixed per delivery. */
  model: 'percentage' | 'flat';
  /** 0–100. Required when model is 'percentage'. */
  agent_share_percent: number | null;
  /** Minor units. Required when model is 'flat'. */
  agent_flat_fee: number | null;
  currency: string;
}

/**
 * The agent's operating zone FOR THIS CONTRACT — a constraint layered on top of
 * the agent's own home base / service radius, and validated as a subset of it.
 * An agency cannot grant coverage the agent never agreed to work.
 */
export interface IContractCoverage {
  /** Named regions/cities this contract covers. */
  regions: string[];
  /** Optional explicit polygon, if the agency draws a zone. */
  area: IPolygon | null;
}

export interface IAgentAgencyContract extends Document {
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  status: ContractStatus;
  origin: ContractOrigin;
  /**
   * The agent's default agency. Exactly one allocating contract per agent may
   * be primary; enforced by a partial unique index below.
   */
  is_primary: boolean;

  // ── Negotiated terms ────────────────────────────────────────────────────────
  cod: IContractCod;
  payment: IContractPayment;
  employment: IMembershipEmployment;
  remittance_terms: IContractRemittanceTerms;
  coverage: IContractCoverage;
  fee_split: IContractFeeSplit;
  /**
   * Optional cap on the value of a SINGLE shipment this agency will assign to
   * this agent — independent of the COD threshold. A high-value item can sit
   * inside COD headroom and still be more than this agency wants to risk with
   * this agent. null = no per-shipment cap.
   */
  shipment_value_ceiling: number | null;

  // ── Lifecycle stamps ────────────────────────────────────────────────────────
  invited_by_user_id: mongoose.Types.ObjectId | null;
  invited_at: Date | null;
  requested_at: Date | null;
  approved_at: Date | null;
  approved_by_user_id: mongoose.Types.ObjectId | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  paused_at: Date | null;
  pause_reason: string | null;
  suspended_at: Date | null;
  suspended_by_user_id: mongoose.Types.ObjectId | null;
  suspension_reason: string | null;
  deactivated_at: Date | null;
  deactivated_by_user_id: mongoose.Types.ObjectId | null;
  deactivation_reason: string | null;
  /** Set when this contract ended because the agent moved to another agency. */
  transferred_to_agency_id: mongoose.Types.ObjectId | null;

  created_at: Date;
  updated_at: Date;
}

/** Backwards-compatible alias. */
export type IAgentAgencyMembership = IAgentAgencyContract;

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const EmploymentSchema = new Schema(
  {
    employment_type: {
      type: String,
      enum: ['employee', 'contractor', 'freelancer'],
      default: 'contractor',
      required: true,
    },
    employee_ref: { type: String, default: null, trim: true },
    started_at: { type: Date, default: null },
    ends_at: { type: Date, default: null },
  },
  { _id: false }
);

const ContractCodSchema = new Schema(
  {
    threshold: {
      type: Number,
      default: 0,
      min: AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MIN,
      max: AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MAX,
      required: true,
    },
    outstanding_balance: { type: Number, default: 0, min: 0, required: true },
    lifetime_settled: { type: Number, default: 0, min: 0, required: true },
    last_settled_at: { type: Date, default: null },
  },
  { _id: false }
);

const ContractPaymentSchema = new Schema(
  {
    outstanding_to_agent: { type: Number, default: 0, min: 0, required: true },
    lifetime_paid: { type: Number, default: 0, min: 0, required: true },
    last_paid_at: { type: Date, default: null },
  },
  { _id: false }
);

const RemittanceTermsSchema = new Schema(
  {
    cadence: {
      type: String,
      enum: ['per_delivery', 'daily', 'weekly', 'biweekly', 'monthly', 'on_demand'],
      default: 'daily',
      required: true,
    },
    day_of_week: { type: Number, default: null, min: 0, max: 6 },
    day_of_month: { type: Number, default: null, min: 1, max: 28 },
    grace_hours: { type: Number, default: 24, min: 0, required: true },
  },
  { _id: false }
);

const CoverageSchema = new Schema(
  {
    regions: { type: [String], default: [] },
    area: { type: PolygonSchema, default: null },
  },
  { _id: false }
);

const FeeSplitSchema = new Schema(
  {
    model: { type: String, enum: ['percentage', 'flat'], default: 'percentage', required: true },
    agent_share_percent: { type: Number, default: null, min: 0, max: 100 },
    agent_flat_fee: { type: Number, default: null, min: 0 },
    currency: { type: String, default: 'XAF', required: true },
  },
  { _id: false }
);

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const contractDefaults = {
  cod: (): IContractCod => ({
    threshold: 0,
    outstanding_balance: 0,
    lifetime_settled: 0,
    last_settled_at: null,
  }),
  payment: (): IContractPayment => ({
    outstanding_to_agent: 0,
    lifetime_paid: 0,
    last_paid_at: null,
  }),
  employment: (): IMembershipEmployment => ({
    employment_type: 'contractor',
    employee_ref: null,
    started_at: null,
    ends_at: null,
  }),
  remittanceTerms: (): IContractRemittanceTerms => ({
    cadence: 'daily',
    day_of_week: null,
    day_of_month: null,
    grace_hours: 24,
  }),
  coverage: (): IContractCoverage => ({ regions: [], area: null }),
  feeSplit: (): IContractFeeSplit => ({
    model: 'percentage',
    agent_share_percent: null,
    agent_flat_fee: null,
    currency: 'XAF',
  }),
};

// ─── Schema ───────────────────────────────────────────────────────────────────

const AgentAgencyContractSchema = new Schema<IAgentAgencyContract>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    status: {
      type: String,
      enum: ['pending', 'rejected', 'active', 'paused', 'suspended', 'deactivated'],
      default: 'pending',
      required: true,
    },
    origin: {
      type: String,
      enum: ['invitation', 'join_request', 'transfer', 'admin', 'migration'],
      required: true,
    },
    is_primary: { type: Boolean, default: false, required: true },

    cod: { type: ContractCodSchema, default: contractDefaults.cod },
    payment: { type: ContractPaymentSchema, default: contractDefaults.payment },
    employment: { type: EmploymentSchema, default: contractDefaults.employment },
    remittance_terms: { type: RemittanceTermsSchema, default: contractDefaults.remittanceTerms },
    coverage: { type: CoverageSchema, default: contractDefaults.coverage },
    fee_split: { type: FeeSplitSchema, default: contractDefaults.feeSplit },
    shipment_value_ceiling: { type: Number, default: null, min: 0 },

    invited_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    invited_at: { type: Date, default: null },
    requested_at: { type: Date, default: null },
    approved_at: { type: Date, default: null },
    approved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    rejected_at: { type: Date, default: null },
    rejection_reason: { type: String, default: null, trim: true },
    paused_at: { type: Date, default: null },
    pause_reason: { type: String, default: null, trim: true },
    suspended_at: { type: Date, default: null },
    suspended_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    suspension_reason: { type: String, default: null, trim: true },
    deactivated_at: { type: Date, default: null },
    deactivated_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    deactivation_reason: { type: String, default: null, trim: true },
    transferred_to_agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * At most ONE live contract per (agent, agency). Partial so that terminal rows
 * (`rejected`, `deactivated`) accumulate as history and a re-contract creates a
 * fresh row. This is also the race guard for concurrent accept/approve.
 */
AgentAgencyContractSchema.index(
  { agent_id: 1, agency_id: 1 },
  { unique: true, partialFilterExpression: { status: { $in: LIVE_CONTRACT_STATUSES } } }
);

/** At most one primary agency per agent, among allocating contracts. */
AgentAgencyContractSchema.index(
  { agent_id: 1 },
  {
    unique: true,
    partialFilterExpression: { is_primary: true, status: { $in: ALLOCATING_CONTRACT_STATUSES } },
  }
);

/** Agency roster listing + the "who can I dispatch?" query. */
AgentAgencyContractSchema.index({ agency_id: 1, status: 1, created_at: -1 });

/** Agent-side "which agencies am I in?" and the allocation-sum query. */
AgentAgencyContractSchema.index({ agent_id: 1, status: 1 });

export const AgentAgencyContractModel = mongoose.model<IAgentAgencyContract>(
  MODELS.AGENT_AGENCY_CONTRACT,
  AgentAgencyContractSchema,
  COLLECTIONS.AGENT_AGENCY_CONTRACT
);

/** Backwards-compatible alias — call sites still importing the old name work. */
export const AgentAgencyMembershipModel = AgentAgencyContractModel;
