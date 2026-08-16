export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
  };
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface LogoutRequest {
  refreshToken: string;
}

export interface MeResponse {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
}

export interface CreateDeviceRequest {
  label: string;
  platform?: "windows" | "android" | "web" | "other";
  appVersion?: string;
}

export interface RegisterDeviceRequest {
  label: string;
  platform: "windows" | "android" | "web" | "other";
  appVersion?: string;
}

export interface RegisterDeviceResponse {
  device: DeviceResponse;
  deviceToken: string;
}

export interface DeviceResponse {
  id: string;
  label: string;
  platform?: string;
  status: string;
  createdAt: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface CreatePairingCodeResponse {
  id: string;
  code: string;
  expiresAt: string;
}

export interface PairingCodeResponse {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}
