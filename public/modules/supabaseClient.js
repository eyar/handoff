import { createClient } from "/vendor/supabase/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "/config.js";

export { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
