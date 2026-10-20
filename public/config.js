// Add your Supabase values from Dashboard → Project Settings → API.
// The publishable key is designed to be included in browser code. Never use a secret key here.

// Default to the shared cloud project so localhost and remote mobile devices connect to the same realtime room!
// Only use local docker supabase if explicitly requested via ?local_supabase=1 or localStorage
const isLocal =
  typeof window !== "undefined" &&
  (new URLSearchParams(window.location.search).get("local_supabase") === "1" ||
    window.localStorage?.getItem("use_local_supabase") === "true");

// Local development values (from `supabase status`)
const LOCAL_SUPABASE_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:54321`
    : "http://127.0.0.1:54321";
const LOCAL_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";

// Production values
const PROD_SUPABASE_URL = "https://kljzghiiovsvymixqgrf.supabase.co";
const PROD_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_CrO5DO9HYvrCJUrkow24AQ_uB14CVX2";

export const SUPABASE_URL = isLocal ? LOCAL_SUPABASE_URL : PROD_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = isLocal
  ? LOCAL_SUPABASE_PUBLISHABLE_KEY
  : PROD_SUPABASE_PUBLISHABLE_KEY;

