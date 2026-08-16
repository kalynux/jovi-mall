import { richDocSchema } from '../../../core/richtext';

/**
 * The `descriptionRich` fragment, in ONE definition shared by all four product
 * write schemas — the layered create/update in `product.validator.ts` and the
 * two `.strict()` quick-add schemas in `simple-product.validator.ts`.
 *
 * One definition rather than four copies for the same reason `BargainRangeSchema`
 * is shared between the layered and simple editors: a field that means one thing
 * on the wizard and another on quick-add is a bug nobody can see from either
 * file.
 *
 * **All four must accept it together.** The two simple schemas are top-level
 * `.strict()`, so an unknown key there is not stripped — it is a
 * `400 VALIDATION_ERROR` that rejects the *entire* save. The two layered ones
 * merely strip it. Add the field to only some of them and the advanced wizard
 * appears to work while the quick-add editor 400s on every save, which is the
 * worst possible split and the reason the dashboard gated the whole feature
 * behind one constant.
 *
 * Three-valued on purpose:
 *
 * | Sent       | Means                                          |
 * |------------|------------------------------------------------|
 * | absent     | leave the stored document alone                |
 * | an object  | replace the stored document                    |
 * | `null`     | clear it — the vendor deleted their formatting |
 *
 * `null` must CLEAR rather than be ignored. Omitting it on an emptied
 * description would leave the old rich document in place while `description` was
 * replaced, and the next read would resurrect formatting the vendor deliberately
 * removed.
 *
 * ⚠️ Not `clearable()`. That helper coerces `''` and whitespace to `null`, which
 * is the right normalisation for a text input and meaningless for an object —
 * the empty document here is `null`, and a client sending `''` has a bug worth
 * hearing about.
 */
export const descriptionRichSchema = richDocSchema.nullable().optional();

export { richDocSchema };
