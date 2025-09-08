// utils/peerConfiguration.js
const peerConfiguration = {
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80"
    },
    {
      urls: "turn:asia.relay.metered.ca:80",
      username: "72f03df1b6a58f38d7fd81ab",
      credential: "guctVzh/8qDU4KU0"
    },
    {
      urls: "turn:asia.relay.metered.ca:80?transport=tcp",
      username: "72f03df1b6a58f38d7fd81ab",
      credential: "guctVzh/8qDU4KU0"
    },
    {
      urls: "turn:asia.relay.metered.ca:443",
      username: "72f03df1b6a58f38d7fd81ab",
      credential: "guctVzh/8qDU4KU0"
    },
    {
      urls: "turns:asia.relay.metered.ca:443?transport=tcp",
      username: "72f03df1b6a58f38d7fd81ab",
      credential: "guctVzh/8qDU4KU0"
    }
  ]
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
