/**
 * Free public MQTT brokers (WebSocket over TLS) used as signaling relays.
 * Messages go through all of them at once, so one being down doesn't matter.
 * Keep this list in sync with connect-src in vercel.json / public/_headers.
 */
export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
