import { useEffect, useRef, useState } from "react";
import socketConnection from "../utils/socketConnection";
import peerConfiguration from "../utils/peerConfiguration";
import ActionButtons from "./ActionButton";

// role: 'teacher' | 'student'
const AudioCall = ({ displayName, roomId, role = "student" }) => {
  const [haveMedia, setHaveMedia] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(null);
  const [localStream, setLocalStream] = useState(null);

  // For students: single RTCPeerConnection
  const pcRef = useRef(null);
  // For teacher: map of RTCPeerConnections keyed by student socket id
  const pcsRef = useRef({});

  const socketRef = useRef(null);
  // For student: an audio element to play teacher (or remote) audio
  const audioRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleSize: 16,
            channelCount: 1,
            sampleRate: 16000,
          },
          video: false,

        });
        if (!mounted) return;
        setLocalStream(stream);
        setHaveMedia(true);
        setAudioEnabled(true);

        // connect socket
        const socket = socketConnection(displayName, roomId);
        socketRef.current = socket;

        // join/create room
        if (role === "teacher") socket.emit("createRoom", { roomId });
        else socket.emit("joinRoom", { roomId });

        // --- STUDENT FLOW ---
        if (role !== "teacher") {
          const pc = new RTCPeerConnection(peerConfiguration);
          pcRef.current = pc;

          // add local tracks
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));

          // remote track (teacher audio)
          pc.ontrack = (event) => {
            let inboundStream = audioRef.current.srcObject;
            if (!inboundStream) {
              inboundStream = new MediaStream();
              audioRef.current.srcObject = inboundStream;
            }
            inboundStream.addTrack(event.track);
            audioRef.current.play().catch(() => { });
          };

          // ICE candidate -> send to server
          pc.onicecandidate = (event) => {
            if (event.candidate && socketRef.current) {
              socketRef.current.emit("sendIceCandidateToSignalingServer", {
                offererSocketId: socketRef.current.id,
                candidate: event.candidate,
                fromSocketId: socketRef.current.id,
              });
            }
          };

          // Listen for answer from teacher
          socket.on("answerResponse", async (entireOffer) => {
            if (!pcRef.current) return;
            if (entireOffer.answer) {
              try {
                await pcRef.current.setRemoteDescription(entireOffer.answer);
              } catch (err) {
                console.warn("student setRemoteDescription error:", err);
              }
            }
          });

          // ICE candidates forwarded by server
          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload || !payload.candidate) return;
            if (pcRef.current) {
              try {
                await pcRef.current.addIceCandidate(
                  new RTCIceCandidate(payload.candidate)
                );
              } catch { }
            }
          });

          // availableOffers (reconnect handling)
          socket.on("availableOffers", (offers) => {
            const myOffer = offers.find(
              (o) =>
                o.offererSocketId === socketRef.current.id && o.answer
            );
            if (
              myOffer &&
              myOffer.answer &&
              pcRef.current &&
              !pcRef.current.remoteDescription
            ) {
              pcRef.current
                .setRemoteDescription(myOffer.answer)
                .catch(() => { });
            }
          });

          // create and send offer (student is offerer)
          if (pc.signalingState === "stable") {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("newOffer", offer, (ack) => {
              console.log("student: offer sent ack", ack);
            });
          }
        } else {
          // --- TEACHER FLOW ---

          // helper to create a pc for a particular student socket id
          const createPcForStudent = (studentSocketId) => {
            if (pcsRef.current[studentSocketId])
              return pcsRef.current[studentSocketId];

            const pc = new RTCPeerConnection(peerConfiguration);
            pcsRef.current[studentSocketId] = pc;

            // teacher's local tracks (mic) added to each pc
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));

            pc.ontrack = (ev) => {
              console.log("teacher: remote track from student", studentSocketId, ev);

              let audioElem = document.getElementById(`audio-${studentSocketId}`);
              if (!audioElem) {
                audioElem = document.createElement("audio");
                audioElem.id = `audio-${studentSocketId}`;
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                document.body.appendChild(audioElem); // TEMP: directly append
              }

              let inboundStream = audioElem.srcObject;
              if (!inboundStream) {
                inboundStream = new MediaStream();
                audioElem.srcObject = inboundStream;
              }
              inboundStream.addTrack(ev.track);
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
                            await pc.addIceCandidate(
                              new RTCIceCandidate(c)
                            );
                          } catch { }
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
                          } catch { }
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
              } catch { }
            }
          });

          // room closed
          socket.on("roomClosed", ({ reason }) => {
            console.log("roomClosed", reason);
            Object.keys(pcsRef.current).forEach((k) => {
              try {
                pcsRef.current[k]
                  .getSenders()
                  .forEach((s) => s.track?.stop());
                pcsRef.current[k].close();
              } catch { }
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
          pcRef.current
            .getSenders()
            .forEach((sender) => sender.track?.stop());
          pcRef.current.close();
        } catch { }
      }
      Object.values(pcsRef.current || {}).forEach((pc) => {
        try {
          pc.getSenders().forEach((s) => s.track?.stop());
          pc.close();
        } catch { }
      });

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
      <audio ref={audioRef} autoPlay playsInline controls />
      <ActionButtons localStream={localStream} toggleAudio={toggleAudio} />
      <div style={{ marginTop: 10 }}>
        <div>Room: {roomId}</div>
        <div>Microphone available: {haveMedia ? "Yes" : "No"}</div>
        <div>Audio enabled: {audioEnabled ? "Yes" : "No"}</div>
      </div>
    </div>
  );
};

export default AudioCall;
