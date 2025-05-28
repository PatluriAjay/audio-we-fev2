import React, { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

const WebVoiceRecorder = ({ onRecordingComplete }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");
  const [isConverting, setIsConverting] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioPlayerRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const playbackTimerRef = useRef(null);
  const ffmpegRef = useRef(new FFmpeg());

  const [selectedRecording, setSelectedRecording] = useState(null);
  const [recordingsList, setRecordingsList] = useState([]);
  const [recordingFormats, setRecordingFormats] = useState({}); // State to track format selection for each recording

  // FFmpeg setup
  const loadFFmpeg = async () => {
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    try {
      if (!ffmpegRef.current.loaded) {
        setError("Loading audio converter...");
        await ffmpegRef.current.load({
          coreURL: `${baseURL}/ffmpeg-core.js`,
          wasmURL: `${baseURL}/ffmpeg-core.wasm`,
        });
        setError("");
        console.log("FFmpeg loaded successfully");
      }
    } catch (err) {
      console.error("Failed to load FFmpeg:", err);
      setError("Failed to load audio converter. Please try again.");
    }
  };

  // Fetch recordings from backend
  const fetchRecordings = async () => {
    try {
      const response = await fetch("http://localhost:5000/api/recordings");
      if (response.ok) {
        const data = await response.json();
        setRecordingsList(data);
        console.log("Fetched recordings:", data);
      } else {
        console.error("Failed to fetch recordings:", await response.json());
      }
    } catch (error) {
      console.error("Network error fetching recordings:", error);
    }
  };

  // Add this function at the top of your component
const normalizeServerUrl = (url) => {
  if (!url) return null;
  
  // Replace 10.0.2.2 with localhost if accessing from browser
  if (window.location.hostname === 'localhost') {
    return url.replace('10.0.2.2', 'localhost');
  }
  
  // Replace localhost with 10.0.2.2 if accessing from Android emulator
  if (window.location.hostname === '10.0.2.2') {
    return url.replace('localhost', '10.0.2.2');
  }
  
  return url;
};

  // Get the appropriate URL based on selected format for a specific recording
const getRecordingUrl = (recording) => {
  const selectedFormat = recordingFormats[recording._id] || "mp3";
  let url;
  
  switch (selectedFormat) {
    case "mp3":
      url = recording.mp3?.url;
      break;
    case "mp4":
      url = recording.mp4?.url;
      break;
    default:
      url = recording.mp3?.url;
  }
  
  return normalizeServerUrl(url);
};

  // Get display name for recording
  const getRecordingDisplayName = (recording) => {
    return recording.originalFilename || recording.filename;
  };

  // Get file info for selected format for a specific recording
  const getRecordingInfo = (recording) => {
    const selectedFormat = recordingFormats[recording._id] || "mp3"; // Default to mp3
    switch (selectedFormat) {
      case "mp3":
        return recording.mp3 || {};
      case "mp4":
        return recording.mp4 || {};
      default:
        return recording.mp3 || {}; // Fallback to mp3
    }
  };

  // Initial load and cleanup
  useEffect(() => {
    loadFFmpeg();
    fetchRecordings();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  // Check browser support
  const checkSupport = () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Your browser does not support audio recording.");
      return false;
    }

    if (!window.MediaRecorder) {
      setError("MediaRecorder is not supported in your browser.");
      return false;
    }

    return true;
  };

  // Get supported MIME type for initial recording
  const getSupportedMimeType = () => {
    const possibleTypes = [
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/webm",
      "audio/mp4",
      "audio/aac",
    ];

    for (const mimeType of possibleTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        console.log("Using initial MediaRecorder MIME type:", mimeType);
        return mimeType;
      }
    }

    console.warn(
      "No preferred MIME type supported for initial recording, using default."
    );
    return "";
  };

  // Start recording
  const startRecording = async () => {
    if (!checkSupport()) return;
    if (!ffmpegRef.current.loaded) {
      setError("Audio converter is not loaded yet. Please wait.");
      return;
    }

    stopPlayback();
    setSelectedRecording(null);

    try {
      setError("");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
          channelCount: 1,
        },
      });

      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : {};

      mediaRecorderRef.current = new MediaRecorder(stream, options);

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const initialBlob = new Blob(chunksRef.current, {
          type: mediaRecorderRef.current.mimeType,
        });
        setAudioBlob(initialBlob);

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
        }

        setIsConverting(true);
        setError("Converting audio to MP4 (AAC)...");

        try {
          await ffmpegRef.current.writeFile(
            "input.file",
            await fetchFile(initialBlob)
          );

          await ffmpegRef.current.exec([
            "-i",
            "input.file",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "output.m4a",
          ]);

          const data = await ffmpegRef.current.readFile("output.m4a");
          const m4aBlob = new Blob([data.buffer], { type: "audio/mp4" });
          setAudioBlob(m4aBlob);

          const url = URL.createObjectURL(m4aBlob);
          setAudioUrl(url);

          if (onRecordingComplete) {
            onRecordingComplete(m4aBlob, url);
          }
          setError("");
        } catch (convertError) {
          console.error("Failed to convert to M4A:", convertError);
          setError("Failed to convert audio: " + convertError.message);
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          setAudioUrl("");
          setAudioBlob(null);
        } finally {
          setIsConverting(false);
        }
      };

      mediaRecorderRef.current.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        setError("Recording failed: " + event.error.message);
      };

      mediaRecorderRef.current.start(1000);
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      console.log(
        "Recording started with MIME type:",
        mediaRecorderRef.current.mimeType
      );
    } catch (error) {
      console.error("Failed to start recording:", error);
      setError("Failed to start recording: " + error.message);
    }
  };

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  // Update the startPlayback function
const startPlayback = () => {
  const urlToPlay = selectedRecording
    ? getRecordingUrl(selectedRecording)
    : audioUrl;

  if (audioPlayerRef.current && urlToPlay) {
    if (isPlaying) {
      stopPlayback();
    }

    console.log('Playing URL:', urlToPlay); // Add this for debugging

    audioPlayerRef.current.src = urlToPlay;
    audioPlayerRef.current.crossOrigin = "anonymous";
    audioPlayerRef.current.load();
    audioPlayerRef.current
      .play()
      .then(() => {
        setIsPlaying(true);
        setPlaybackTime(0);
        if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
        playbackTimerRef.current = setInterval(() => {
          if (audioPlayerRef.current) {
            setPlaybackTime(Math.floor(audioPlayerRef.current.currentTime));
          }
        }, 1000);
      })
      .catch((error) => {
        console.error("Error playing audio:", error);
        setError(`Failed to play audio: ${error.message}. URL: ${urlToPlay}`);
        setIsPlaying(false);
        if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
      });
  } else {
    // setError(`No audio URL available for selected format. URL: ${urlToPlay}`);
  }
};

  // Stop playback
  const stopPlayback = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setPlaybackTime(0);
    setSelectedRecording(null);

    if (playbackTimerRef.current) {
      clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  };

  // Format time display
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  // Handle audio ended event
  const handleAudioEnded = () => {
    setIsPlaying(false);
    setPlaybackTime(0);
    if (playbackTimerRef.current) {
      clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    setSelectedRecording(null);
  };

  const buttonStyle = {
    padding: "12px 24px",
    margin: "5px",
    border: "none",
    borderRadius: "8px",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
    transition: "all 0.2s ease",
  };

  const recordButtonStyle = {
    ...buttonStyle,
    backgroundColor: isRecording ? "#ff4444" : "#4CAF50",
    color: "white",
  };

  const getPlayButtonStyle = (isCurrentPlayback = false) => ({
    ...buttonStyle,
    backgroundColor: isPlaying && isCurrentPlayback ? "#ff4444" : "#2196F3",
    color: "white",
    padding: "5px",
  });

  // Handle local recording submission
  const handleSubmit = async () => {
    if (!audioBlob) {
      setError("No audio to submit. Please record something first.");
      return;
    }

    setError("");
    const formData = new FormData();
    const filename = `recording_${Date.now()}.${
      audioBlob.type.split("/")[1] || "m4a"
    }`;
    formData.append("audio", audioBlob, filename);

    try {
      const response = await fetch(
        "http://localhost:5000/api/recordings/upload",
        {
          method: "POST",
          body: formData,
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log("Server upload successful:", data);
        setError("");
        fetchRecordings();
        setAudioBlob(null);
        if (audioUrl) {
          URL.revokeObjectURL(audioUrl);
          setAudioUrl("");
        }
      } else {
        const errorData = await response.json();
        console.error("Server upload failed:", errorData);
        setError("Upload failed: " + (errorData.message || "Unknown error"));
      }
    } catch (uploadError) {
      console.error("Network error during upload:", uploadError);
      setError("Network error: Could not connect to server.");
    }
  };

  // Handle format change for a specific recording
  const handleFormatChange = (recordingId, newFormat) => {
    setRecordingFormats((prev) => ({
      ...prev,
      [recordingId]: newFormat,
    }));

    // If this recording is currently playing, stop it
    if (selectedRecording?._id === recordingId && isPlaying) {
      stopPlayback();
    }
  };

  // Play fetched recording from the list
  const playRecording = (recording) => {
    if (selectedRecording?._id === recording._id && isPlaying) {
      stopPlayback();
      return;
    }

    setSelectedRecording(recording);
    startPlayback();
  };

  // Format file size
  const formatFileSize = (bytes) => {
    if (!bytes) return "0 KB";
    return (bytes / 1024).toFixed(2) + " KB";
  };

  return (
    <>
      <div
        style={{
          padding: "20px",
          margin: "0 auto",
          border: "1px solid #ccc",
          borderRadius: "10px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
        }}
      >
        <h2
          style={{ textAlign: "center", marginBottom: "20px", color: "#333" }}
        >
          Web Voice Recorder
        </h2>

        {(error || isConverting) && (
          <div
            style={{
              color: isConverting ? "#2196F3" : "#ff4444",
              backgroundColor: isConverting ? "#e6f3ff" : "#ffe6e6",
              padding: "10px",
              borderRadius: "5px",
              marginBottom: "20px",
              textAlign: "center",
              border: `1px solid ${isConverting ? "#2196F3" : "#ff4444"}`,
            }}
          >
            {error || "Converting..."}
          </div>
        )}

        {/* Recording section */}
        <div style={{ marginBottom: "20px", textAlign: "center" }}>
          <div
            style={{ marginBottom: "10px", fontSize: "18px", color: "#555" }}
          >
            Recording Time: {formatTime(recordingTime)}
          </div>

          <button
            style={recordButtonStyle}
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!!error || isConverting || !ffmpegRef.current.loaded}
          >
            {isRecording ? "⏹ Stop Recording" : "🎤 Start Recording"}
          </button>
        </div>

        {/* Hidden Audio Player */}
        <audio
          ref={audioPlayerRef}
          onEnded={handleAudioEnded}
          style={{ display: "none" }}
          crossOrigin="anonymous"
        />

        {/* Local Playback and Submit Section */}
        {audioUrl && (
          <div
            style={{
              textAlign: "center",
              marginBottom: "20px",
              borderTop: "1px solid #eee",
              paddingTop: "15px",
            }}
          >
            <h3 style={{ marginBottom: "10px", color: "#333" }}>
              Local Recording Playback
            </h3>
            <div
              style={{ marginBottom: "10px", fontSize: "18px", color: "#555" }}
            >
              Playback Time: {formatTime(playbackTime)}
            </div>

            <button
              style={getPlayButtonStyle(isPlaying && !selectedRecording)}
              onClick={
                isPlaying && !selectedRecording ? stopPlayback : startPlayback
              }
              disabled={isConverting}
            >
              {isPlaying && !selectedRecording
                ? "⏹ Stop Playing"
                : "▶ Play Recording"}
            </button>

            <div
              style={{
                marginTop: "15px",
                fontSize: "12px",
                color: "#666",
                wordBreak: "break-all",
              }}
            >
              <strong>File info:</strong>
              <br />
              Type: {audioBlob?.type || "Unknown"}
              <br />
              Size: {formatFileSize(audioBlob?.size)}
            </div>

            <button
              style={{
                ...buttonStyle,
                backgroundColor: "#007bff",
                color: "white",
                marginTop: "10px",
              }}
              onClick={handleSubmit}
              disabled={isConverting || !audioBlob}
            >
              Submit Recording
            </button>
          </div>
        )}
      </div>

      {/* Recordings List */}
      <div
        style={{
          marginTop: "30px",
          padding: "20px",
          margin: "0 auto",
          border: "1px solid #ccc",
          borderRadius: "10px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
        }}
      >
        <h3
          style={{ textAlign: "center", marginBottom: "15px", color: "#333" }}
        >
          Saved Audio Files
        </h3>

        {recordingsList.length > 0 ? (
          <div>
            {recordingsList.map((recording) => {
              const selectedFormat = recordingFormats[recording._id] || "mp3";
              const recordingInfo = getRecordingInfo(recording);
              const isAvailable = !!getRecordingUrl(recording);

              return (
                <div
                  key={recording._id}
                  style={{
                    padding: "10px",
                    margin: "5px",
                    backgroundColor:
                      selectedRecording?._id === recording._id
                        ? "#e6f3ff"
                        : "#fcfcfc",
                    border: `1px solid ${
                      selectedRecording?._id === recording._id
                        ? "#a0d9ff"
                        : "#eee"
                    }`,
                    borderRadius: "5px",
                    display: "flex",
                    flexDirection: "column",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                    opacity: isAvailable ? 1 : 0.6,
                  }}
                >
                  {/* Main content row */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "8px",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "14px",
                          fontWeight: "bold",
                          color: "#333",
                        }}
                      >
                        {getRecordingDisplayName(recording)}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#666",
                          marginTop: "2px",
                        }}
                      >
                        {new Date(recording.uploadDate).toLocaleString()}
                      </div>
                    </div>
                    <button
                      style={{
                        ...getPlayButtonStyle(
                          selectedRecording?._id === recording._id
                        ),
                        opacity: isAvailable ? 1 : 0.5,
                      }}
                      onClick={() => playRecording(recording)}
                      disabled={isConverting || !isAvailable}
                      title={
                        !isAvailable
                          ? `${selectedFormat.toUpperCase()} format not available`
                          : ""
                      }
                    >
                      {selectedRecording?._id === recording._id && isPlaying
                        ? "⏹ Stop"
                        : "▶ Play"}
                    </button>
                  </div>

                  {/* Format selection and info row */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      borderTop: "1px solid #eee",
                      paddingTop: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <label
                        style={{
                          fontSize: "12px",
                          color: "#555",
                          fontWeight: "bold",
                        }}
                      >
                        Format:
                      </label>
                      <select
                        value={selectedFormat}
                        onChange={(e) =>
                          handleFormatChange(recording._id, e.target.value)
                        }
                        style={{
                          padding: "3px 6px",
                          borderRadius: "4px",
                          border: "1px solid #ccc",
                          fontSize: "12px",
                          backgroundColor: "white",
                        }}
                      >
                        <option value="mp3">MP3</option>
                        <option value="mp4">MP4</option>
                      </select>
                    </div>

                    <div
                      style={{
                        fontSize: "11px",
                        color: "#888",
                        textAlign: "right",
                      }}
                    >
                      {recordingInfo.mimetype || "N/A"} |{" "}
                      {formatFileSize(recordingInfo.size)}
                      {!isAvailable && " (Not available)"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p
            style={{ textAlign: "center", color: "#666", fontStyle: "italic" }}
          >
            No recordings available from the server.
          </p>
        )}
      </div>
    </>
  );
};

export default WebVoiceRecorder;
