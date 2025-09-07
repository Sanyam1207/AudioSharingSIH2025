import React from 'react';

const ActionButtons = ({ localStream, toggleAudio }) => (
  <div style={{ marginTop: "10px" }}>
    <button onClick={toggleAudio}>
      {localStream && localStream.getAudioTracks()[0].enabled ? "Mute" : "Unmute"}
    </button>
  </div>
);

export default ActionButtons;