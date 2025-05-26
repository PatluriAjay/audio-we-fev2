import React, { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg"; // Import FFmpeg
import { fetchFile } from "@ffmpeg/util"; // Helper to fetch files for FFmpeg

const WebVoiceRecorder = ({ onRecordingComplete }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(""); // URL for the locally recorded audio
  const [error, setError] = useState("");
  const [isConverting, setIsConverting] = useState(false); // New state for conversion status

  const mediaRecorderRef = useRef(null);
  const audioPlayerRef = useRef(null); // Unified ref for the single audio element
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const playbackTimerRef = useRef(null);
  const ffmpegRef = useRef(new FFmpeg()); // Initialize FFmpeg instance

  const [selectedRecording, setSelectedRecording] = useState(null); // State to track which fetched recording is selected
  const [recordingsList, setRecordingsList] = useState([]);

  // --- FFmpeg setup ---
  const loadFFmpeg = async () => {
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm"; // Use a CDN for core files
    try {
      if (!ffmpegRef.current.loaded) {
        setError("Loading audio converter...");
        await ffmpegRef.current.load({
          coreURL: `${baseURL}/ffmpeg-core.js`,
          wasmURL: `${baseURL}/ffmpeg-core.wasm`,
          // For web workers: workerURL: `${baseURL}/ffmpeg-core.worker.js`,
        });
        setError(""); // Clear error once loaded
        console.log("FFmpeg loaded successfully");
      }
    } catch (err) {
      console.error("Failed to load FFmpeg:", err);
      setError("Failed to load audio converter. Please try again.");
    }
  };

  // --- Fetch recordings from backend ---
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

  // --- Initial load and cleanup ---
  useEffect(() => {
    loadFFmpeg(); // Load FFmpeg when the component mounts
    fetchRecordings(); // Fetch existing recordings on mount

    return () => {
      // Clear timers
      if (timerRef.current) clearInterval(timerRef.current);
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);

      // Stop media stream tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      // Revoke object URL for local recording if it exists
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      // Note: FFmpeg instance can persist or be terminated based on app needs.
      // For this component, we'll let it persist across renders.
      // If you need to explicitly terminate it on unmount, uncomment:
      // if (ffmpegRef.current && ffmpegRef.current.loaded) {
      //   ffmpegRef.current.terminate();
      // }
    };
  }, [audioUrl]); // Depend on audioUrl for cleanup of that specific URL

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

  // Get supported MIME type for initial recording (prioritize Opus if possible)
  const getSupportedMimeType = () => {
    const possibleTypes = [
      "audio/webm;codecs=opus", // WebM with Opus (ideal for direct recording)
      "audio/mp4;codecs=mp4a.40.2", // AAC in MP4
      "audio/webm", // WebM fallback
      "audio/mp4", // MP4 fallback
      "audio/aac", // Raw AAC
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
    return ""; // Let browser choose (often WebM or MP4)
  };

  // Start recording
  const startRecording = async () => {
    if (!checkSupport()) return;
    if (!ffmpegRef.current.loaded) {
      setError("Audio converter is not loaded yet. Please wait.");
      return;
    }

    // Stop any current playback before starting a new recording
    stopPlayback();
    setSelectedRecording(null); // Clear selected fetched recording

    try {
      setError("");

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000, // Common for Opus, better quality
          channelCount: 1, // Mono for smaller file size
        },
      });

      streamRef.current = stream;
      chunksRef.current = [];

      // Configure MediaRecorder with compatible settings
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
        setAudioBlob(initialBlob); // Set initial blob for info display

        // Stop all tracks from the recording stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
        }

        setIsConverting(true); // Indicate conversion is starting
        setError("Converting audio to MP4 (AAC)...");

        try {
          // Write the initial recording to FFmpeg's virtual file system
          await ffmpegRef.current.writeFile(
            "input.file",
            await fetchFile(initialBlob)
          );

          await ffmpegRef.current.exec([
            "-i",
            "input.file",
            "-c:a",
            "aac", // Use AAC codec
            "-b:a",
            "128k", // Higher bitrate for better quality
            "-movflags",
            "+faststart", // Optimize for web playback
            "output.m4a", // M4A output
          ]);

          // Read the converted file
          const data = await ffmpegRef.current.readFile("output.m4a");
          const m4aBlob = new Blob([data.buffer], { type: "audio/mp4" });
          setAudioBlob(m4aBlob); // Update state with the M4A blob

          // Create URL for playback of the local recording
          const url = URL.createObjectURL(m4aBlob);
          setAudioUrl(url);

          // Call callback with the blob for upload
          if (onRecordingComplete) {
            onRecordingComplete(m4aBlob, url);
          }
          setError(""); // Clear conversion message
        } catch (convertError) {
          console.error("Failed to convert to M4A:", convertError);
          setError("Failed to convert audio: " + convertError.message);
          // Revoke the initial blob URL if conversion fails
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          setAudioUrl("");
          setAudioBlob(null);
        } finally {
          setIsConverting(false); // Conversion finished
        }
      };

      mediaRecorderRef.current.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        setError("Recording failed: " + event.error.message);
      };

      // Start recording
      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
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

  // Start playback (unified for local and fetched audio)
  const startPlayback = () => {
    const urlToPlay = selectedRecording ? selectedRecording.url : audioUrl;

    if (audioPlayerRef.current && urlToPlay) {
      // If already playing, stop current playback first
      if (isPlaying) {
        stopPlayback();
      }

      audioPlayerRef.current.src = urlToPlay;
      audioPlayerRef.current.crossOrigin = "anonymous"; // Important for CORS if hosted separately
      audioPlayerRef.current.load(); // Load the new source
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
          setError("Failed to play audio: " + error.message);
          setIsPlaying(false); // Reset playing state on error
          if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
        });
    } else {
      setError("");
    }
  };

  // Stop playback (unified)
  const stopPlayback = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setPlaybackTime(0);
    // When stopping, deselect any currently playing fetched recording
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

  // Handle audio ended event (for the main audio player)
  const handleAudioEnded = () => {
    setIsPlaying(false);
    setPlaybackTime(0);
    if (playbackTimerRef.current) {
      clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    setSelectedRecording(null); // Clear selection when playback ends
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

  // Dynamic play button style for consistency
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

    setError(""); // Clear previous errors
    const formData = new FormData();
    // Use a more descriptive filename
    formData.append(
      "audio",
      audioBlob,
      `recording_${Date.now()}.${audioBlob.type.split("/")[1] || "m4a"}`
    );

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
        // Fetch updated recordings list after successful upload
        fetchRecordings();
        // Clear local recording state after submission
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

  // Play fetched recording from the list
  const playRecording = (recording) => {
    // If this specific fetched recording is already playing, stop it.
    if (selectedRecording?._id === recording._id && isPlaying) {
      stopPlayback(); // This will also clear selectedRecording
      return;
    }

    // Otherwise, set this as the selected recording and start playback
    setSelectedRecording(recording);
    startPlayback(); // Call unified startPlayback
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

        {/* Hidden Audio Player - Always present in DOM */}
        <audio
          ref={audioPlayerRef}
          onEnded={handleAudioEnded}
          style={{ display: "none" }} // Keep it hidden
          crossOrigin="anonymous"
        />

        {/* Local Playback and Submit Section (only appears after a local recording is made) */}
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
              style={getPlayButtonStyle(isPlaying && !selectedRecording)} // Apply style if local audio is playing
              onClick={
                isPlaying && !selectedRecording ? stopPlayback : startPlayback
              }
              disabled={isConverting} // Disable if conversion is in progress
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
              Size: {audioBlob ? (audioBlob.size / 1024).toFixed(2) : 0} KB
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
          <div
            style={{
              maxHeight: "300px",
              overflowY: "auto",
              border: "1px solid #eee",
              borderRadius: "5px",
            }}
          >
            {recordingsList.map((recording) => (
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
                  justifyContent: "space-between",
                  alignItems: "center",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "14px",
                      fontWeight: "bold",
                      color: "#333",
                    }}
                  >
                    {recording.filename}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    {new Date(recording.uploadDate).toLocaleString()}
                  </div>
                </div>
                <button
                  style={getPlayButtonStyle(
                    selectedRecording?._id === recording._id
                  )}
                  onClick={() => playRecording(recording)}
                  disabled={isConverting} // Disable while FFmpeg is busy
                >
                  {selectedRecording?._id === recording._id && isPlaying
                    ? "⏹ Stop"
                    : "▶ Play"}
                </button>
              </div>
            ))}
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
