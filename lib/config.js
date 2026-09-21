/**
 * Configuration primitives shared by both rows.
 *
 * A path-loaded plugin cannot import the harness schema package, so the
 * Standard Schema the loader validates is written out here.
 */

/**
 * Wrap one row's config normalizer as the Standard Schema a plugin row exports.
 *
 * Cordis validates a row's exported `Config` through
 * `Config['~standard'].validate` before `apply` runs (`vendor/cordis`
 * `resolveConfig`), and a plain resolver function has no such member: the
 * loader then fails the whole plugin tree at boot. Normalizers here are total,
 * so validation always succeeds and returns the coerced value. `toJSON` keeps
 * the loader's describe surface.
 * @param {(value: unknown) => object} normalize - total config normalizer.
 * @param {() => object} describe - JSON description of the config fields.
 * @returns {object} the schema object a row exports as `Config`.
 */
export function standardSchema(normalize, describe) {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-cursor',
      validate(value) {
        return { value: normalize(value) }
      },
    },
    toJSON: describe,
  }
}

/**
 * Coerce a configured value to a positive integer.
 * @param {unknown} value - candidate from row configuration.
 * @param {number} fallback - value used when the candidate is not a positive finite number.
 * @returns {number} the coerced count or budget.
 */
export function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Coerce a configured value to a string.
 * @param {unknown} value - candidate from row configuration.
 * @returns {string} the string, or `''` for anything else.
 */
export function textOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}
