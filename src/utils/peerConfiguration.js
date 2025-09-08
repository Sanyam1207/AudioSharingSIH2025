// utils/peerConfiguration.js
const peerConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: [
        "turn:relay1.expressturn.com:3478",
        "turn:relay1.expressturn.com:3479",
        "turn:relay1.expressturn.com:3480",
        "turn:relay1.expressturn.com:5349",
      ],
      username: "000000002072709872",
      credential: "RcNGsN/ChbwjcrwJKP71rlZoaHE=",
    },
  ],
};

export default peerConfiguration;

// 🔍 Utility function to attach debug logging
export function attachIceDebugLogs(pc, label = "Peer") {
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`[${label}] ICE candidate:`, event.candidate.candidate);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${label}] ICE state:`, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${label}] Connection state:`, pc.connectionState);
  };
}
