export interface User {
  id: string;
  username: string | null;
  email: string | null;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

export interface AuthSession {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  token_selector: string | null;
  token_secret_hash: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface Device {
  id: string;
  user_id: string;
  label: string;
  platform: string;
  status: "offline" | "online";
  created_at: string;
  paired_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface PairingCode {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  device_id: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  device_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  ip_hash: string | null;
  created_at: string;
}

export interface DeviceToken {
  id: string;
  device_id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface RelayConnection {
  id: string;
  user_id: string | null;
  device_id: string | null;
  client_id: string | null;
  direction: "bridge" | "client";
  connected_at: string;
  disconnected_at: string | null;
}
