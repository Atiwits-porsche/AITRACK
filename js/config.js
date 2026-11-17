/*
 * Supabase connection (optional).
 * Leave empty to use the app offline on a single device.
 * Fill in to sign in and sync across every device — see README "ตั้งค่า Supabase".
 *
 * The anon / publishable key is designed to be public: your data is protected by the
 * Row Level Security policies in supabase/schema.sql, not by hiding this key.
 * NEVER put the service_role / secret key here.
 */
window.AITRACK_CONFIG = {
  supabaseUrl: 'https://qddupexksvxbcqopdvpp.supabase.co',
  supabaseAnonKey: 'sb_publishable_vcUcJ9E4rPlH-y6AZSEgfQ_KxlhbjgS', // publishable key (safe to expose)
};
