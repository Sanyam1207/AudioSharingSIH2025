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


  // Student: single RTCPeerConnection
  const pcRef = useRef(null);
  // Teacher: map of RTCPeerConnections keyed by student socket id
  // Each entry will be an object: { pc, micSenders: [], mixDestination, mixTrack, nodesFromSources: { [sourceId]: [ { source, gain } ] } }
  const pcsRef = useRef({});
  // Socket ref

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


  // Shared stream for teacher to mix all student tracks into one element locally (teacher hears combined)
  const sharedStreamRef = useRef(new MediaStream());
  // Map to track which tracks came from which student (for removal on disconnect)
  const studentTracksRef = useRef({}); // { [studentSocketId]: MediaStreamTrack[] }


  // AudioContext and per-target mix destinations (teacher only)
  const audioContextRef = useRef(null);
  // Keep track mapping: sourceStudentId -> { targetStudentId -> [ { sourceNode, gainNode } ] }
  const mixNodesRef = useRef({}); // nested map for cleanup

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

          // --- TEACHER FLOW ---
          // create single AudioContext (but it will be started only after user gesture)
          try {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
          } catch (e) {
            console.warn("AudioContext creation failed:", e);
            audioContextRef.current = null;
          }

          // remove all tracks for a specific student from teacher's shared stream and from other targets
          const removeStudentTracks = (id) => {
            const tracks = studentTracksRef.current[id];
            if (tracks && sharedStreamRef.current) {
              tracks.forEach((t) => {
                try {
                  sharedStreamRef.current.removeTrack(t);
                } catch (e) {
                  console.warn("shared removeTrack error", e);
                }
              });
            }
            delete studentTracksRef.current[id];

            // remove source nodes created from this source and disconnect them from all target mix destinations
            const perSource = mixNodesRef.current[id];
            if (perSource) {
              Object.keys(perSource).forEach((targetId) => {
                const arr = perSource[targetId] || [];
                arr.forEach(({ sourceNode, gainNode }) => {
                  try {
                    sourceNode.disconnect();
                  } catch (e) { }
                  try {
                    gainNode.disconnect();
                  } catch (e) { }
                });
              });
              delete mixNodesRef.current[id];
            }

            // Also stop any nodes specifically created for this id (no need to remove tracks from destinations
            // because nodes have been disconnected).
          };

          // helper to create a pc object for a particular student socket id
          const createPcForStudent = (studentSocketId) => {
            // if already exists, return existing pc object
            if (pcsRef.current[studentSocketId]) return pcsRef.current[studentSocketId].pc;


            const pc = new RTCPeerConnection(peerConfiguration);


            // create a per-target mix destination for this target student (this destination will contain
            // all other students' audio; initially it's empty/silent)
            const audioCtx = audioContextRef.current;
            const mixDestination = audioCtx ? audioCtx.createMediaStreamDestination() : null;
            const mixTrack = mixDestination ? mixDestination.stream.getAudioTracks()[0] : null;


            if (audioCtx && mixDestination) {
              Object.keys(studentTracksRef.current).forEach((sourceStudentId) => {
                if (sourceStudentId === studentSocketId) return; // don't forward their own track
                (studentTracksRef.current[sourceStudentId] || []).forEach((track) => {
                  try {
                    const sourceNode = audioCtx.createMediaStreamSource(new MediaStream([track]));
                    const gainNode = audioCtx.createGain();
                    gainNode.gain.value = 1.0; // adjust if you need to lower volume
                    sourceNode.connect(gainNode);
                    gainNode.connect(mixDestination);

                    // bookkeeping so we can disconnect later when sourceStudentId leaves
                    mixNodesRef.current[sourceStudentId] = mixNodesRef.current[sourceStudentId] || {};
                    mixNodesRef.current[sourceStudentId][studentSocketId] =
                      mixNodesRef.current[sourceStudentId][studentSocketId] || [];
                    mixNodesRef.current[sourceStudentId][studentSocketId].push({
                      sourceNode,
                      gainNode,
                      trackId: track.id,
                    });

                    pcsRef.current[studentSocketId] = pcsRef.current[studentSocketId] || {};
                    pcsRef.current[studentSocketId].nodesFromSources =
                      pcsRef.current[studentSocketId].nodesFromSources || {};
                    pcsRef.current[studentSocketId].nodesFromSources[sourceStudentId] =
                      pcsRef.current[studentSocketId].nodesFromSources[sourceStudentId] || [];
                    pcsRef.current[studentSocketId].nodesFromSources[sourceStudentId].push({
                      sourceNode,
                      gainNode,
                      trackId: track.id,
                    });
                  } catch (e) {
                    console.warn("attach existing track to new target err", e);
                  }
                });
              });
            }

            // store object with helpers
            pcsRef.current[studentSocketId] = {
              pc,
              micSenders: [],
              mixDestination, // AudioNode destination, we will connect sources into it
              mixTrack, // track that we'll attach before answering
              nodesFromSources: {}, // for bookkeeping: sourceId -> [ { sourceNode, gainNode } ]
            };

            // add teacher's local mic tracks to each pc (so teacher's voice goes to each student)
            stream.getTracks().forEach((track) => {
              try {
                const sender = pc.addTrack(track, stream);
                pcsRef.current[studentSocketId].micSenders.push(sender);
              } catch (e) {
                console.warn("teacher addTrack (mic) err", e);
              }
            });

            // add the per-target mixTrack into this pc (so this student will receive the mixed audio)
            if (mixTrack) {
              try {
                pc.addTrack(mixTrack, mixDestination.stream);
              } catch (e) {
                console.warn("teacher addTrack(mix) err", e);
              }
            }

            pc.ontrack = (ev) => {
              // This ontrack is called when the student provides their stream to teacher
              // Keep their incoming tracks for teacher-local playback and bookkeeping
              console.log("teacher: ontrack from student", studentSocketId, ev);
              if (ev.streams && ev.streams[0]) {
                ev.streams[0].getTracks().forEach((incomingTrack) => {
                  // add to teacher's shared local stream (so teacher hears everyone)
                  if (!sharedStreamRef.current.getTracks().find((t) => t.id === incomingTrack.id)) {
                    try {
                      sharedStreamRef.current.addTrack(incomingTrack);
                      studentTracksRef.current[studentSocketId] =
                        studentTracksRef.current[studentSocketId] || [];
                      studentTracksRef.current[studentSocketId].push(incomingTrack);
                    } catch (e) {
                      console.warn("teacher shared addTrack error", e);
                    }
                  }

                  // For each OTHER target student PC, create a MediaStreamSource from this incoming track
                  // and connect it into that target's mixDestination so they receive this student's audio.
                  Object.keys(pcsRef.current).forEach((targetId) => {
                    if (targetId === studentSocketId) return; // don't forward to the source itself

                    const targetObj = pcsRef.current[targetId];
                    if (!targetObj || !targetObj.mixDestination || !audioContextRef.current) return;

                    // create nodes & connect
                    try {
                      const sourceNode = audioContextRef.current.createMediaStreamSource(
                        new MediaStream([incomingTrack])
                      );
                      const gainNode = audioContextRef.current.createGain();
                      gainNode.gain.value = 1.0; // you can lower this to avoid clipping when many students speak
                      sourceNode.connect(gainNode);
                      gainNode.connect(targetObj.mixDestination);

                      // store bookkeeping so we can remove when this source disconnects
                      mixNodesRef.current[studentSocketId] = mixNodesRef.current[studentSocketId] || {};
                      mixNodesRef.current[studentSocketId][targetId] =
                        mixNodesRef.current[studentSocketId][targetId] || [];
                      mixNodesRef.current[studentSocketId][targetId].push({
                        sourceNode,
                        gainNode,
                        trackId: incomingTrack.id,
                      });

                      // also record in the target's nodesFromSources for cleanup, if you prefer
                      targetObj.nodesFromSources[studentSocketId] =
                        targetObj.nodesFromSources[studentSocketId] || [];
                      targetObj.nodesFromSources[studentSocketId].push({
                        sourceNode,
                        gainNode,
                        trackId: incomingTrack.id,
                      });
                    } catch (e) {
                      console.warn("teacher createMediaStreamSource/connect err", e);
                    }
                  });
                });

                // attach the combined shared stream to the teacher's single audio element
                if (audioRef.current) {
                  audioRef.current.srcObject = sharedStreamRef.current;
                  audioRef.current.play().catch((err) => {
                    console.warn("Autoplay blocked for shared audio:", err);
                  });
                }
              } else {
                // fallback single-track case
                const t = ev.track;
                if (t && !sharedStreamRef.current.getTracks().find((x) => x.id === t.id)) {
                  try {
                    sharedStreamRef.current.addTrack(t);
                    studentTracksRef.current[studentSocketId] =
                      studentTracksRef.current[studentSocketId] || [];
                    studentTracksRef.current[studentSocketId].push(t);
                  } catch (e) {
                    console.warn("teacher shared addTrack (single) err", e);
                  }
                }
              } catch (e) {
                console.warn("teacher WebAudio playback err", e);
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

              console.log(
                `pc[${studentSocketId}] connectionState:`,
                pc.connectionState,
                "signalingState:",
                pc.signalingState
              );
              if (
                pc.connectionState === "disconnected" ||
                pc.connectionState === "failed" ||
                pc.connectionState === "closed"
              ) {
                // cleanup that student's tracks & nodes
                try {
                  removeStudentTracks(studentSocketId);
                } catch (e) { }
              }
            };

            // ensure tracks/nodes are removed when pc.close is called
            const oldClose = pc.close.bind(pc);
            pc.close = () => {
              try {
                removeStudentTracks(studentSocketId);
              } catch (e) { }
              try {
                oldClose();
              } catch (e) { }

            };

            return pc;
          };

          // Handle offers list
          socket.on("availableOffers", async (offers = []) => {
            for (const offer of offers) {
              try {
                const pc = createPcForStudent(offer.offererSocketId);

                const pcObj = pcsRef.current[offer.offererSocketId];

                if (!pcObj.pc.remoteDescription) {
                  await pcObj.pc.setRemoteDescription(offer.offer);
                }

                if (pcObj.pc.signalingState === "have-remote-offer") {
                  const answer = await pcObj.pc.createAnswer();
                  await pcObj.pc.setLocalDescription(answer);

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: offer.offererSocketId, answer },
                    (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        offererIceCandidates.forEach(async (c) => {
                          try {
                            await pcObj.pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (availableOffers) err", e);
                          }
                        });
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${offer.offererSocketId}, state=${pcObj.pc.signalingState}`
                  );

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
              const pcObj = pcsRef.current[student];
              try {

                if (!pcObj.pc.remoteDescription) {
                  await pcObj.pc.setRemoteDescription(offerObj.offer);
                }

                if (pcObj.pc.signalingState === "have-remote-offer") {
                  const answer = await pcObj.pc.createAnswer();
                  await pcObj.pc.setLocalDescription(answer);

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: student, answer },
                    async (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        for (const c of offererIceCandidates) {
                          try {
                            await pcObj.pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (newOfferAwaiting) err", e);
                          }
                        }
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${student}, state=${pcObj.pc.signalingState}`
                  );

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


            const pcEntry = pcsRef.current[from];
            if (pcEntry && pcEntry.pc) {
              try {
                await pcEntry.pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.warn("teacher addIceCandidate (receivedIceCandidateFromServer) err", e);
              }
            } else {
              // candidate might be for an offerer -> find corresponding entry via offererSocketId mapping
              // attempt to find correct pc by checking keys
              const found = Object.values(pcsRef.current).find((x) => x && x.pc && x.pc.connectionState !== undefined);
              if (found) {
                try {
                  await found.pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                  console.warn("teacher addIceCandidate (receivedIceCandidateFromServer fallback) err", e);
                }
              }

            }
          });

          socket.on("roomClosed", ({ reason }) => {
            console.log("roomClosed", reason);

            // remove all student tracks and disconnect nodes
            Object.keys(studentTracksRef.current).forEach((id) => {
              (studentTracksRef.current[id] || []).forEach((t) => {
                try {
                  sharedStreamRef.current.removeTrack(t);
                  t.stop?.();
                } catch (e) { }
              });
            });
            studentTracksRef.current = {};

            // disconnect all mix nodes
            Object.keys(mixNodesRef.current).forEach((sourceId) => {
              Object.keys(mixNodesRef.current[sourceId]).forEach((targetId) => {
                (mixNodesRef.current[sourceId][targetId] || []).forEach(({ sourceNode, gainNode }) => {
                  try {
                    sourceNode.disconnect();
                  } catch { }
                  try {
                    gainNode.disconnect();
                  } catch { }
                });
              });
            });
            mixNodesRef.current = {};

            // close all pcs
            Object.keys(pcsRef.current).forEach((k) => {
              try {
                pcsRef.current[k].pc.getSenders().forEach((s) => s.track?.stop());
                pcsRef.current[k].pc.close();
              } catch { }

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

        try {
          pcRef.current.getSenders().forEach((sender) => sender.track?.stop());
          pcRef.current.close();
        } catch { }
      }

      Object.values(pcsRef.current || {}).forEach((pcObj) => {
        try {
          pcObj.pc.getSenders().forEach((s) => s.track?.stop());
          pcObj.pc.close();
        } catch { }
      });

      // remove and stop all student tracks from shared stream and disconnect nodes
      Object.keys(studentTracksRef.current).forEach((id) => {
        (studentTracksRef.current[id] || []).forEach((t) => {
          try {
            sharedStreamRef.current.removeTrack(t);
            t.stop?.();
          } catch (e) { }
        });
      });
      studentTracksRef.current = {};

      Object.keys(mixNodesRef.current).forEach((src) => {
        Object.keys(mixNodesRef.current[src]).forEach((tgt) => {
          (mixNodesRef.current[src][tgt] || []).forEach(({ sourceNode, gainNode }) => {
            try {
              sourceNode.disconnect();
            } catch { }
            try {
              gainNode.disconnect();
            } catch { }
          });
        });
      });
      mixNodesRef.current = {};

      // clear and stop shared stream tracks
      try {
        sharedStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop?.();
          } catch { }
        });
      } catch { }
      sharedStreamRef.current = new MediaStream();


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


      {/* Teacher-only button: single user gesture to satisfy autoplay / AudioContext policies */}
      {role === "teacher" && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={async () => {
              try {
                if (audioContextRef.current && audioContextRef.current.state === "suspended") {
                  await audioContextRef.current.resume();
                }
                const a = audioRef.current;
                if (a) {
                  a.muted = false;
                  a.srcObject = sharedStreamRef.current;
                  a.play().catch(() => { });
                }
              } catch (e) {
                console.warn("Enable student audio button error:", e);
              }
            }}
          >
            Enable student audio (click once)
          </button>

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
