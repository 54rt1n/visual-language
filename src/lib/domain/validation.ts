/** Authored input correction safe to return to a model; never wrap arbitrary exceptions. */
export class InputValidationError extends Error {
  override name = 'InputValidationError'
}
