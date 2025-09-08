// components/AudioCall.jsx
import { useEffect, useRef, useState } from "react";
import socketConnection from "../utils/socketConnection";
import peerConfiguration from "../utils/peerConfiguration";
import ActionButtons from "./ActionButton";

// props: displayName, roomId, role ('teacher' | 'student')
const AudioCall = ({ displayName, roomId, role = "student" }) => {
  const [haveMedia, setHaveMedia] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(null);
  const [localStream, setLocalStream] = useState(null);

  const pcRef = useRef(null); // student pc
  const pcsRef = useRef({}); // teacher: map studentId -> pc
  const socketRef = useRef(null);
  const audioRef = useRef(null); // single element for students (and fallback)

  // teacher helpers
  const audioContextRef = useRef(null);
  const studentForwardRef = useRef({}); // forwarding pipeline to other students
  const perStudentAudioElsRef = useRef({}); // DOM audio elements per student (fallback)
  const perStudentWebAudioSourceRef = useRef({}); // { studentId: MediaStreamAudioSourceNode } for playback
  const perStudentRawTracksRef = useRef({}); // raw incoming tracks for cleanup

  // enable teacher audio on user gesture: resume audio context and unmute/play per-student audio elements
  const enableTeacherAudio = async () => {
    try {
      if (audioContextRef.current && audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
        console.log("AudioContext resumed");
      }
    } catch (e) {
      console.warn("AudioContext resume error", e);
    }

    // unmute/play per-student elements
    Object.entries(perStudentAudioElsRef.current).forEach(([id, el]) => {
      try {
        el.muted = false;
        el.volume = 1;
        el.play().catch((e) => console.warn("per-student el play failed", id, e));
      } catch (e) { console.warn("enableTeacherAudio el err", e); }
    });

    // also try to play the main audioRef if visible (keep compatibility)
    try {
      if (audioRef.current) {
        audioRef.current.muted = false;
        audioRef.current.play().catch((e) => console.warn("main audioRef play failed", e));
      }
    } catch (e) { console.warn(e); }

    console.log("enableTeacherAudio done");
  };

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        console.log("AudioCall setup:", { displayName, roomId, role });

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleSize: 16, channelCount: 1, sampleRate: 16000 },
          video: false,
        });

        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        setLocalStream(stream);
        setHaveMedia(true);
        setAudioEnabled(true);

        // connect socket
        const socket = socketConnection(displayName, roomId);
        socketRef.current = socket;
        socket.on("connect", () => console.log("socket connected", socket.id));
        socket.on("disconnect", (r) => console.log("socket disconnected", r));

        if (role === "teacher") {
          socket.emit("createRoom", { roomId });

          // init audio context
          try {
            if (!audioContextRef.current) {
              audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
              console.log("AudioContext created:", audioContextRef.current.state);
            }
          } catch (e) {
            console.warn("AudioContext init failed", e);
            audioContextRef.current = null;
          }
        } else {
          socket.emit("joinRoom", { roomId });
        }

        // ---------- STUDENT flow ----------
        if (role !== "teacher") {
          const pc = new RTCPeerConnection(peerConfiguration);
          pcRef.current = pc;

          // add local tracks
          stream.getTracks().forEach((t) => pc.addTrack(t, stream));

          pc.ontrack = (ev) => {
            console.log("student: ontrack (teacher->student)", ev);
            const el = audioRef.current;
            if (!el) return;
            if (ev.streams && ev.streams[0]) {
              el.srcObject = ev.streams[0];
            } else {
              if (!el.srcObject) el.srcObject = new MediaStream();
              try { el.srcObject.addTrack(ev.track); } catch (e) { console.warn("student addTrack fallback", e); }
            }
            el.play().catch((e) => console.warn("student audio play failed", e));
          };

          pc.onicecandidate = (event) => {
            if (event.candidate && socketRef.current) {
              socketRef.current.emit("sendIceCandidateToSignalingServer", {
                offererSocketId: socketRef.current.id,
                candidate: event.candidate,
                fromSocketId: socketRef.current.id,
              });
            }
          };

          socket.on("answerResponse", async (entireOffer) => {
            if (!pcRef.current) return;
            if (entireOffer.answer) {
              try {
                await pcRef.current.setRemoteDescription(entireOffer.answer);
                console.log("student setRemoteDescription done");
              } catch (err) {
                console.warn("student setRemoteDescription error", err);
              }
            }
          });

          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload || !payload.candidate) return;
            if (pcRef.current) {
              try { await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { console.warn("student addIceCandidate err", e); }
            }
          });

          socket.on("availableOffers", (offers) => {
            const myOffer = offers.find((o) => o.offererSocketId === socketRef.current.id && o.answer);
            if (myOffer && myOffer.answer && pcRef.current && !pcRef.current.remoteDescription) {
              pcRef.current.setRemoteDescription(myOffer.answer).catch((e) => console.warn("student availableOffers err", e));
            }
          });

          // create and send offer
          if (pc.signalingState === "stable") {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              socket.emit("newOffer", offer, (ack) => console.log("student newOffer ack", ack));
            } catch (err) {
              console.warn("student createOffer error", err);
            }
          }
        } else {
          // ---------- TEACHER flow ----------
          const createPerStudentAudioElement = (studentId) => {
            let el = perStudentAudioElsRef.current[studentId];
            if (el) return el;
            el = document.createElement("audio");
            el.id = `student-audio-${studentId}`;
            el.autoplay = true;
            el.playsInline = true;
            el.controls = false;
            // visually hide but keep in DOM
            el.style.position = "fixed";
            el.style.left = "-10000px";
            el.style.width = "1px";
            el.style.height = "1px";
            el.muted = true; // start muted, teacher will unmute on gesture
            document.body.appendChild(el);
            perStudentAudioElsRef.current[studentId] = el;
            return el;
          };

          const teardownPerStudent = (studentId) => {
            try {
              const el = perStudentAudioElsRef.current[studentId];
              if (el) {
                el.pause();
                try { el.srcObject = null; } catch {}
                el.remove();
              }
            } catch (e) {}
            delete perStudentAudioElsRef.current[studentId];

            try {
              const srcNode = perStudentWebAudioSourceRef.current[studentId];
              if (srcNode) {
                try { srcNode.disconnect(); } catch {}
              }
            } catch (e) {}
            delete perStudentWebAudioSourceRef.current[studentId];

            // teardown forwarding pipeline if any
            const forward = studentForwardRef.current[studentId];
            if (forward) {
              Object.values(forward.senders || {}).forEach((s) => {
                try { s.replaceTrack?.(null); } catch {}
              });
              try { forward.sourceNode.disconnect(); } catch {}
              try { forward.forwardedTrack?.stop?.(); } catch {}
            }
            delete studentForwardRef.current[studentId];

            // remove raw track entry
            const raw = perStudentRawTracksRef.current[studentId];
            if (raw) {
              try { raw.stop?.(); } catch {}
            }
            delete perStudentRawTracksRef.current[studentId];
            console.log("teardownPerStudent done for", studentId);
          };

          const addForwardedTracksToPc = (pc, targetStudentId) => {
            Object.entries(studentForwardRef.current).forEach(([srcStudentId, forward]) => {
              if (srcStudentId === targetStudentId) return;
              if (!forward.senders[targetStudentId]) {
                try {
                  const sender = pc.addTrack(forward.forwardedTrack, forward.destNode.stream);
                  forward.senders[targetStudentId] = sender;
                } catch (e) {
                  console.warn("add forwarded track to new pc failed", e);
                }
              }
            });
          };

          const createPcForStudent = (studentSocketId) => {
            if (pcsRef.current[studentSocketId]) return pcsRef.current[studentSocketId];

            const pc = new RTCPeerConnection(peerConfiguration);
            pcsRef.current[studentSocketId] = pc;

            // teacher mic -> student
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));

            // add existing forwarded tracks
            addForwardedTracksToPc(pc, studentSocketId);

            pc.ontrack = (ev) => {
              console.log("teacher: ontrack from", studentSocketId, ev);

              // Ensure track is enabled
              try { ev.track.enabled = true; } catch (e) {}

              // 1) WebAudio playback for teacher (preferred once audioContext resumed)
              try {
                if (audioContextRef.current) {
                  const trackStream = new MediaStream([ev.track]);
                  // create a MediaStreamSource and connect to destination
                  try {
                    const sourceNode = audioContextRef.current.createMediaStreamSource(trackStream);
                    sourceNode.connect(audioContextRef.current.destination);
                    perStudentWebAudioSourceRef.current[studentSocketId] = sourceNode;
                    console.log("teacher: connected WebAudio source for", studentSocketId);
                  } catch (e) {
                    console.warn("teacher: createMediaStreamSource failed", e);
                  }
                } else {
                  console.warn("teacher: no AudioContext, skipping WebAudio playback");
                }
              } catch (e) {
                console.warn("teacher WebAudio playback err", e);
              }

              // 2) Per-student audio element fallback (so teacher can click-play)
              try {
                const el = createPerStudentAudioElement(studentSocketId);
                const streamForEl = new MediaStream([ev.track]);
                el.srcObject = streamForEl;
                el.muted = true; // keep muted until teacher clicks enable (to satisfy autoplay)
                el.play().catch((e) => {
                  // often will be rejected unless muted or after gesture; that's OK
                  console.warn("per-student element play attempt:", e);
                });
                console.log("teacher: attached track to per-student audio element for", studentSocketId);
              } catch (e) {
                console.warn("teacher per-student audio attach failed", e);
              }

              // Keep raw reference for cleanup
              perStudentRawTracksRef.current[studentSocketId] = ev.track;

              // Forwarding pipeline for other students: create a local forwarded track (via AudioContext) and add to other PCs
              try {
                if (!studentForwardRef.current[studentSocketId]) {
                  if (!audioContextRef.current) {
                    console.warn("teacher: audioContext missing, cannot create forwarded track");
                  } else {
                    const srcNodeForForward = audioContextRef.current.createMediaStreamSource(new MediaStream([ev.track]));
                    const destNodeForForward = audioContextRef.current.createMediaStreamDestination();
                    srcNodeForForward.connect(destNodeForForward);
                    const forwardedTrack = destNodeForForward.stream.getAudioTracks()[0];
                    if (!forwardedTrack) {
                      console.warn("teacher: forwardedTrack missing");
                    } else {
                      studentForwardRef.current[studentSocketId] = {
                        sourceNode: srcNodeForForward,
                        destNode: destNodeForForward,
                        forwardedTrack,
                        senders: {},
                      };

                      // add forwardedTrack to all other students' PCs
                      Object.entries(pcsRef.current).forEach(([otherId, otherPc]) => {
                        if (otherId === studentSocketId) return;
                        try {
                          const sender = otherPc.addTrack(forwardedTrack, destNodeForForward.stream);
                          studentForwardRef.current[studentSocketId].senders[otherId] = sender;
                        } catch (e) {
                          console.warn("teacher: add forwarded track to otherPc failed", e);
                        }
                      });
                      console.log("teacher: created forwarding pipeline for", studentSocketId);
                    }
                  }
                }
              } catch (e) {
                console.warn("teacher forwarding err", e);
              }
            };

            pc.onicecandidate = (event) => {
              if (event.candidate && socketRef.current) {
                socketRef.current.emit("sendIceCandidateToSignalingServer", {
                  offererSocketId: studentSocketId,
                  candidate: event.candidate,
                  fromSocketId: socketRef.current.id,
                });
              }
            };

            pc.onconnectionstatechange = () => {
              console.log(`pc[${studentSocketId}] state`, pc.connectionState);
              if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
                teardownPerStudent(studentSocketId);
              }
            };

            const oldClose = pc.close.bind(pc);
            pc.close = () => {
              teardownPerStudent(studentSocketId);
              try { oldClose(); } catch (e) {}
            };

            return pc;
          };

          // Handle offers list
          socket.on("availableOffers", async (offers = []) => {
            for (const offer of offers) {
              try {
                const pc = createPcForStudent(offer.offererSocketId);
                if (!pc.remoteDescription) await pc.setRemoteDescription(offer.offer);
                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  socket.emit("newAnswer", { offererSocketId: offer.offererSocketId, answer }, (offererIceCandidates) => {
                    if (Array.isArray(offererIceCandidates)) {
                      offererIceCandidates.forEach(async (c) => {
                        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn(e); }
                      });
                    }
                  });
                }
              } catch (err) { console.warn("teacher answering failed", err); }
            }
            console.log("pcs:", Object.keys(pcsRef.current), "forwards:", Object.keys(studentForwardRef.current));
          });

          socket.on("newOfferAwaiting", async (recentOffers) => {
            for (const offerObj of recentOffers) {
              if (!offerObj || offerObj.answer) continue;
              const student = offerObj.offererSocketId;
              if (!student) continue;
              const pc = createPcForStudent(student);
              try {
                if (!pc.remoteDescription) await pc.setRemoteDescription(offerObj.offer);
                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  socket.emit("newAnswer", { offererSocketId: student, answer }, async (offererIceCandidates) => {
                    if (Array.isArray(offererIceCandidates)) {
                      for (const c of offererIceCandidates) {
                        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn(e); }
                      }
                    }
                  });
                }
              } catch (err) { console.warn("teacher newOfferAwaiting fail", err); }
            }
            console.log("pcs:", Object.keys(pcsRef.current), "forwards:", Object.keys(studentForwardRef.current));
          });

          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload) return;
            const from = payload.fromSocketId;
            const candidate = payload.candidate;
            if (!from || !candidate) return;
            const pc = pcsRef.current[from];
            if (pc) {
              try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn(e); }
            }
          });

          socket.on("roomClosed", ({ reason }) => {
            console.log("roomClosed", reason);
            Object.keys(pcsRef.current).forEach((k) => {
              try { pcsRef.current[k].close(); } catch {}
            });
            pcsRef.current = {};
            // teardown per-student artifacts
            Object.keys(perStudentAudioElsRef.current).forEach((id) => teardownPerStudent(id));
            perStudentAudioElsRef.current = {};
            studentForwardRef.current = {};
            perStudentWebAudioSourceRef.current = {};
            perStudentRawTracksRef.current = {};
          });
        }
      } catch (err) {
        console.error("getUserMedia / setup failed:", err);
      }
    };

    setup();

    return () => {
      mounted = false;
      if (socketRef.current) {
        socketRef.current.off("availableOffers");
        socketRef.current.off("newOfferAwaiting");
        socketRef.current.off("answerResponse");
        socketRef.current.off("receivedIceCandidateFromServer");
        socketRef.current.off("roomClosed");
      }

      if (pcRef.current) {
        try { pcRef.current.getSenders().forEach((s) => s.track?.stop()); pcRef.current.close(); } catch {}
      }

      Object.values(pcsRef.current || {}).forEach((pc) => {
        try { pc.getSenders().forEach((s) => s.track?.stop()); pc.close(); } catch {}
      });

      // cleanup per-student artifacts
      Object.keys(perStudentAudioElsRef.current).forEach((id) => {
        try { const el = perStudentAudioElsRef.current[id]; el.pause(); el.srcObject = null; el.remove(); } catch {}
      });
      perStudentAudioElsRef.current = {};
      Object.keys(perStudentWebAudioSourceRef.current).forEach((id) => {
        try { perStudentWebAudioSourceRef.current[id].disconnect(); } catch {}
      });
      perStudentWebAudioSourceRef.current = {};
      Object.keys(studentForwardRef.current).forEach((id) => {
        try { const f = studentForwardRef.current[id]; f.sourceNode?.disconnect(); f.forwardedTrack?.stop?.(); } catch {}
      });
      studentForwardRef.current = {};
      perStudentRawTracksRef.current = {};

      try { audioContextRef.current?.close(); } catch {}
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, roomId, role]);

  const toggleAudio = () => {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks()[0]?.enabled ?? false;
    localStream.getAudioTracks().forEach((track) => (track.enabled = !enabled));
    setAudioEnabled(!enabled);
  };

  return (
    <div>
      <h2>Audio Call — {displayName || "(no name)"} ({role})</h2>

      {/* visible only for students — teacher uses per-student elements */}
      <audio ref={audioRef} autoPlay playsInline controls style={{ display: role === "teacher" ? "none" : "block" }} />

      <ActionButtons localStream={localStream} toggleAudio={toggleAudio} />

      {role === "teacher" && (
        <div style={{ marginTop: 8 }}>
          <button onClick={enableTeacherAudio}>Enable student audio (click once)</button>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <div>Room: {roomId}</div>
        <div>Microphone available: {haveMedia ? "Yes" : "No"}</div>
        <div>Audio enabled: {audioEnabled ? "Yes" : "No"}</div>
      </div>
    </div>
  );
};

export default AudioCall;
