/** Routing suffixes and vendor spelling do not change the model's lesson guidance.
 * The original model ID is always preserved in the API request.
 */
export function modelIdentity(model: string) {
  return model.split('/').at(-1)!.split(':')[0]!.toLowerCase().replace(/[._-]/g, '')
}
