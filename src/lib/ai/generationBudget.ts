// General generation target. Reasoning and native tool arguments share this
// output allowance. Plan prompts around 32K total tokens (input plus output);
// actual provider/model limits may differ. Explicit smaller task limits remain useful.
export const GENERATION_OUTPUT_TOKENS = 4096
export const GENERATION_CONTEXT_TOKENS = 32768
