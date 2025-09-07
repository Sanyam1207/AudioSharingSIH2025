
// utils/socketConnection.js
import { io } from "socket.io-client";

let socket = null;
let currentAuth = { displayName: null, roomId: null };

const socketConnection = (displayName, roomId) => {
  // always create a fresh socket for simplicity; callers can reuse the returned socket
  if (socket && socket.connected) socket.disconnect();

  currentAuth = { displayName, roomId };
  socket = io("https://audiosharingbackendsih2025.onrender.com", { auth: { displayName, roomId } });

  return socket;
};
//dsa
export default socketConnection;