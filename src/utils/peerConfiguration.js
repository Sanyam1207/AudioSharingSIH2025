
// utils/peerConfiguration.js
const peerConfiguration = {
  iceServers: [
    { urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302'
    ]}
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
};

export default peerConfiguration;
