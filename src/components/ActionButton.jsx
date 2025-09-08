// components/ActionButton.jsx
import React from "react";

const ActionButtons = ({ localStream, toggleAudio }) => {
  const isEnabled = Boolean(
    localStream &&
      localStream.getAudioTracks &&
      localStream.getAudioTracks()[0]?.enabled
  );

  return (
    <div style={{ marginTop: "10px" }}>
      <button onClick={toggleAudio}>{isEnabled ? "Mute" : "Unmute"}</button>
    </div>
  );
};

export default ActionButtons;
