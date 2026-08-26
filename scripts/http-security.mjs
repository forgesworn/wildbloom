export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http://*.onion ws://*.onion",
  "worker-src 'self' blob:",
  "trusted-types 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

export const META_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY
  .split("; ")
  .filter((directive) => !directive.startsWith("frame-ancestors "))
  .join("; ");

export const DENIED_PERMISSION_FEATURES = Object.freeze([
  "accelerometer",
  "ambient-light-sensor",
  "attribution-reporting",
  "autoplay",
  "battery",
  "bluetooth",
  "browsing-topics",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "compute-pressure",
  "digital-credentials-create",
  "digital-credentials-get",
  "direct-sockets",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "keyboard-map",
  "local-fonts",
  "magnetometer",
  "mediasession",
  "microphone",
  "midi",
  "otp-credentials",
  "payment",
  "picture-in-picture",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "speaker-selection",
  "storage-access",
  "sync-xhr",
  "tools",
  "usb",
  "web-share",
  "window-management",
  "xr-spatial-tracking",
]);

export const PERMISSIONS_POLICY = DENIED_PERMISSION_FEATURES
  .map((feature) => `${feature}=()`)
  .join(", ");

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": PERMISSIONS_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
