// utils/socketConnection.js
import { io } from "socket.io-client";

let socket = null;
let currentAuth = { displayName: null, roomId: null };

const socketConnection = (displayName, roomId) => {
  // always create a fresh socket for simplicity
  if (socket && socket.connected) socket.disconnect();

  currentAuth = { displayName, roomId };
  socket = io("http://localhost:8181", { auth: { displayName, roomId } });

  return socket;
};

export default socketConnection;
