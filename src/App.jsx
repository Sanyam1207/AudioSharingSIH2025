// App.jsx
import { useState } from "react";
import AudioCall from "./components/AudioCall";

function App() {
  const [userName, setUserName] = useState("");
  const [role, setRole] = useState("student");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);

  const handleJoin = () => {
    if (userName && roomId) {
      setJoined(true);
    }
  };

  if (!joined) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Join Classroom</h1>
        <div style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="Enter your name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            style={{ marginRight: 10 }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={{ marginRight: 10 }}
          >
            <option value="student">Student</option>
            <option value="teacher">Teacher</option>
          </select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="Enter room name (e.g., math, science)"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            style={{ marginRight: 10 }}
          />
        </div>
        <button onClick={handleJoin}>Join Room</button>
      </div>
    );
  }

  // IMPORTANT: pass displayName (AudioCall expects displayName)
  return <AudioCall displayName={userName} role={role} roomId={roomId} />;
}

export default App;
