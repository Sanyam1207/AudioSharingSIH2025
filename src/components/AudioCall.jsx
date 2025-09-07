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
  const pcsRef = useRef({});
  // Socket ref
  const socketRef = useRef(null);
  // Single audio element used for either: student plays teacher stream OR teacher plays mixed student stream
  const audioRef = useRef(null);

  // Shared stream for teacher to mix all student tracks into one element
  const sharedStreamRef = useRef(new MediaStream());
  // Map to track which tracks came from which student (for removal on disconnect)
  const studentTracksRef = useRef({}); // { [studentSocketId]: MediaStreamTrack[] }

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        console.log("AudioCall setup:", { displayName, roomId, role });
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleSize: 16,
            channelCount: 1,
            sampleRate: 16000,
          },
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

        socket.on("connect", () => {
          console.log("socket connected", socket.id);
        });
        socket.on("disconnect", (reason) => {
          console.log("socket disconnected", reason);
        });

        // join/create room
        if (role === "teacher") socket.emit("createRoom", { roomId });
        else socket.emit("joinRoom", { roomId });

        // --- STUDENT FLOW ---
        if (role !== "teacher") {
          const pc = new RTCPeerConnection(peerConfiguration);
          pcRef.current = pc;

          // add local (student) tracks
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));

          // remote track: teacher's audio
          pc.ontrack = (ev) => {
            const el = audioRef.current;
            if (!el) return;
            if (ev.streams && ev.streams[0]) {
              el.srcObject = ev.streams[0];
            } else {
              if (!el.srcObject) el.srcObject = new MediaStream();
              try {
                el.srcObject.addTrack(ev.track);
              } catch (e) {
                console.warn("student addTrack fallback:", e);
              }
            }
            el.play().catch((err) => {
              console.warn("student audio autoplay blocked or failed:", err);
            });
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
                console.log("student: setRemoteDescription(answer) done");
              } catch (err) {
                console.warn("student setRemoteDescription error:", err);
              }
            }
          });

          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload || !payload.candidate) return;
            if (pcRef.current) {
              try {
                await pcRef.current.addIceCandidate(
                  new RTCIceCandidate(payload.candidate)
                );
              } catch (e) {
                console.warn("student addIceCandidate err", e);
              }
            }
          });

          socket.on("availableOffers", (offers) => {
            const myOffer = offers.find(
              (o) => o.offererSocketId === socketRef.current.id && o.answer
            );
            if (myOffer && myOffer.answer && pcRef.current && !pcRef.current.remoteDescription) {
              pcRef.current.setRemoteDescription(myOffer.answer).catch((e) => {
                console.warn("student availableOffers setRemoteDescription err", e);
              });
            }
          });

          // create and send offer (student is offerer)
          if (pc.signalingState === "stable") {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              socket.emit("newOffer", offer, (ack) => {
                console.log("student: offer sent ack", ack);
              });
            } catch (err) {
              console.warn("student createOffer error", err);
            }
          }
        } else {
          // --- TEACHER FLOW ---

          // remove all tracks for a specific student from shared stream
          const removeStudentTracks = (id) => {
            const tracks = studentTracksRef.current[id];
            if (!tracks || !sharedStreamRef.current) return;
            tracks.forEach((t) => {
              try {
                sharedStreamRef.current.removeTrack(t);
                // optionally stop the track: t.stop?.();
              } catch (e) {
                console.warn("removeStudentTracks error", e);
              }
            });
            delete studentTracksRef.current[id];
          };

          // helper to create a pc for a particular student socket id
          const createPcForStudent = (studentSocketId) => {
            if (pcsRef.current[studentSocketId])
              return pcsRef.current[studentSocketId];

            const pc = new RTCPeerConnection(peerConfiguration);
            pcsRef.current[studentSocketId] = pc;

            // add teacher's local mic tracks to each pc
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));

            pc.ontrack = (ev) => {
              console.log("teacher: ontrack from student", studentSocketId, ev);
              const shared = sharedStreamRef.current;

              // prefer full stream if provided
              if (ev.streams && ev.streams[0]) {
                ev.streams[0].getTracks().forEach((incomingTrack) => {
                  if (!shared.getTracks().find((t) => t.id === incomingTrack.id)) {
                    shared.addTrack(incomingTrack);
                    studentTracksRef.current[studentSocketId] =
                      studentTracksRef.current[studentSocketId] || [];
                    studentTracksRef.current[studentSocketId].push(incomingTrack);
                  }
                });
              } else {
                const t = ev.track;
                if (t && !shared.getTracks().find((x) => x.id === t.id)) {
                  shared.addTrack(t);
                  studentTracksRef.current[studentSocketId] =
                    studentTracksRef.current[studentSocketId] || [];
                  studentTracksRef.current[studentSocketId].push(t);
                }
              }

              // attach the combined shared stream to the single audio element
              if (audioRef.current) {
                audioRef.current.srcObject = shared;
                audioRef.current.play().catch((err) => {
                  console.warn("Autoplay blocked for shared audio:", err);
                });
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
                // cleanup that student's tracks
                try {
                  removeStudentTracks(studentSocketId);
                } catch (e) {}
              }
            };

            // ensure tracks are removed when pc.close is called
            const oldClose = pc.close.bind(pc);
            pc.close = () => {
              try {
                removeStudentTracks(studentSocketId);
              } catch (e) {}
              try {
                oldClose();
              } catch (e) {}
            };

            return pc;
          };

          // handle full offers list — answer new ones
          socket.on("availableOffers", async (offers = []) => {
            for (const offer of offers) {
              try {
                const pc = createPcForStudent(offer.offererSocketId);

                if (!pc.remoteDescription) {
                  await pc.setRemoteDescription(offer.offer);
                }

                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: offer.offererSocketId, answer },
                    (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        offererIceCandidates.forEach(async (c) => {
                          try {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (availableOffers) err", e);
                          }
                        });
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${offer.offererSocketId}, state=${pc.signalingState}`
                  );
                }
              } catch (err) {
                console.warn("teacher answering failed", offer.offererSocketId, err);
              }
            }
          });

          // when a new single offer arrives targeted to teacher
          socket.on("newOfferAwaiting", async (recentOffers) => {
            for (const offerObj of recentOffers) {
              if (!offerObj || offerObj.answer) continue;
              const student = offerObj.offererSocketId;
              if (!student) continue;

              const pc = createPcForStudent(student);
              try {
                if (!pc.remoteDescription) {
                  await pc.setRemoteDescription(offerObj.offer);
                }

                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: student, answer },
                    async (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        for (const c of offererIceCandidates) {
                          try {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (newOfferAwaiting) err", e);
                          }
                        }
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${student}, state=${pc.signalingState}`
                  );
                }
              } catch (err) {
                console.warn(
                  "teacher answering failed for (newOfferAwaiting)",
                  student,
                  err
                );
              }
            }
          });

          // received ICE candidate forwarded by server
          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload) return;
            const from = payload.fromSocketId;
            const candidate = payload.candidate;
            if (!from || !candidate) return;

            const pc = pcsRef.current[from];
            if (pc) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.warn("teacher addIceCandidate (receivedIceCandidateFromServer) err", e);
              }
            }
          });

          // room closed
          socket.on("roomClosed", ({ reason }) => {
            console.log("roomClosed", reason);
            // remove all student tracks
            Object.keys(studentTracksRef.current).forEach((id) => {
              (studentTracksRef.current[id] || []).forEach((t) => {
                try {
                  sharedStreamRef.current.removeTrack(t);
                  // t.stop?.();
                } catch (e) {}
              });
            });
            studentTracksRef.current = {};
            // close all pcs
            Object.keys(pcsRef.current).forEach((k) => {
              try {
                pcsRef.current[k].getSenders().forEach((s) => s.track?.stop());
                pcsRef.current[k].close();
              } catch {}
            });
            pcsRef.current = {};
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
        } catch {}
      }

      Object.values(pcsRef.current || {}).forEach((pc) => {
        try {
          pc.getSenders().forEach((s) => s.track?.stop());
          pc.close();
        } catch {}
      });

      // remove and stop all student tracks from shared stream
      Object.keys(studentTracksRef.current).forEach((id) => {
        (studentTracksRef.current[id] || []).forEach((t) => {
          try {
            sharedStreamRef.current.removeTrack(t);
            t.stop?.();
          } catch (e) {}
        });
      });
      studentTracksRef.current = {};

      // clear and stop shared stream tracks
      try {
        sharedStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop?.();
          } catch {}
        });
      } catch {}
      sharedStreamRef.current = new MediaStream();

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
      <h2>
        Audio Call — {displayName || "(no name)"} ({role})
      </h2>

      {/* Single audio element used by both roles:
          - Student: plays teacher stream
          - Teacher: plays mixed student stream (sharedStreamRef is attached in ontrack) */}
      <audio ref={audioRef} autoPlay playsInline controls />

      {/* Action buttons */}
      <ActionButtons localStream={localStream} toggleAudio={toggleAudio} />

      {/* Teacher-only button: single user gesture to satisfy autoplay policies */}
      {role === "teacher" && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => {
              // unmute + try to play the shared audio element
              try {
                const a = audioRef.current;
                if (a) {
                  a.muted = false;
                  a.play().catch(() => {});
                }
              } catch {}
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
