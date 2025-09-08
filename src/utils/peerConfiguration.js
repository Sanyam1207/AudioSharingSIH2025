// utils/peerConfiguration.js
const peerConfiguration = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
    {
      urls: "turn:relay1.expressturn.com:3480",
      username: "000000002072709872",
      credential: "RcNGsN/ChbwjcrwJKP71rlZoaHE=",
    },
  ],
};

export default peerConfiguration;
