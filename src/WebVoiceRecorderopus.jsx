  import React, { useState, useRef, useEffect } from 'react';
  import { FFmpeg } from '@ffmpeg/ffmpeg'; // Import FFmpeg
  import { fetchFile } from '@ffmpeg/util'; // Helper to fetch files for FFmpeg

  const WebVoiceRecorder = ({ onRecordingComplete }) => {
    const [isRecording, setIsRecording] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [playbackTime, setPlaybackTime] = useState(0);
    const [audioBlob, setAudioBlob] = useState(null);
    const [audioUrl, setAudioUrl] = useState('');
    const [error, setError] = useState('');
    const [isConverting, setIsConverting] = useState(false); // New state for conversion status

    const mediaRecorderRef = useRef(null);
    const audioRef = useRef(null);
    const streamRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const playbackTimerRef = useRef(null);
    const ffmpegRef = useRef(new FFmpeg()); // Initialize FFmpeg instance

    // --- FFmpeg setup ---
    const loadFFmpeg = async () => {
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'; // Use a CDN for core files
      try {
        if (!ffmpegRef.current.loaded) { // Check if FFmpeg is already loaded
          setError('Loading converter...');
          await ffmpegRef.current.load({
            coreURL: `${baseURL}/ffmpeg-core.js`,
            wasmURL: `${baseURL}/ffmpeg-core.wasm`,
            // For web workers: workerURL: `${baseURL}/ffmpeg-core.worker.js`,
          });
          setError(''); // Clear error once loaded
          console.log('FFmpeg loaded successfully');
        }
      } catch (err) {
        console.error('Failed to load FFmpeg:', err);
        setError('Failed to load audio converter. Please try again.');
      }
    };

    useEffect(() => {
      loadFFmpeg(); // Load FFmpeg when the component mounts
      // Add other cleanup from your original useEffect here if needed
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
        }
        if (audioUrl) {
          URL.revokeObjectURL(audioUrl);
        }
      };
    }, [audioUrl]); // Depend on audioUrl for cleanup

    // --- End FFmpeg setup ---

    // Check browser support
    const checkSupport = () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('Your browser does not support audio recording.');
        return false;
      }

      if (!window.MediaRecorder) {
        setError('MediaRecorder is not supported in your browser.');
        return false;
      }

      return true;
    };

    // Get supported MIME type for initial recording (prioritize Opus if possible)
    const getSupportedMimeType = () => {
      // Prefer Opus directly if the browser supports it, otherwise fallback
      const possibleTypes = [
        'audio/webm;codecs=opus',      // WebM with Opus (ideal for direct recording)
        'audio/mp4;codecs=mp4a.40.2', // AAC in MP4
        'audio/webm',                  // WebM fallback
        'audio/mp4',                   // MP4 fallback
        'audio/aac',                   // Raw AAC
      ];

      for (const mimeType of possibleTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          console.log('Using initial MediaRecorder MIME type:', mimeType);
          return mimeType;
        }
      }

      console.warn('No preferred MIME type supported for initial recording, using default.');
      return ''; // Let browser choose (often WebM or MP4)
    };

    // Start recording
    const startRecording = async () => {
      if (!checkSupport()) return;
      if (!ffmpegRef.current.loaded) { // Ensure FFmpeg is loaded before starting
        setError('Audio converter is not loaded yet. Please wait.');
        return;
      }

      try {
        setError('');

        // Request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 48000, // Common for Opus, better quality
            channelCount: 1,    // Mono for smaller file size
          }
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

        mediaRecorderRef.current.onstop = async () => { // Made async for conversion
          const initialBlob = new Blob(chunksRef.current, { type: mediaRecorderRef.current.mimeType });
          setAudioBlob(initialBlob); // Set initial blob for info display

          // Stop all tracks
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
          }

          setIsConverting(true); // Indicate conversion is starting
          setError('Converting audio to OPUS...');

          try {
            // Write the initial recording to FFmpeg's virtual file system
            await ffmpegRef.current.writeFile('input.file', await fetchFile(initialBlob));

            // Run FFmpeg command to convert to Opus
            // -i input.file: input file
            // -c:a libopus: use the Opus audio codec
            // -b:a 64k: audio bitrate (adjust as needed, 64k is good for voice)
            // output.opus: output file name
            await ffmpegRef.current.exec(['-i', 'input.file', '-c:a', 'libopus', '-b:a', '64k', 'output.opus']);

            // Read the converted Opus file
            const data = await ffmpegRef.current.readFile('output.opus');
            const opusBlob = new Blob([data.buffer], { type: 'audio/opus' });
            setAudioBlob(opusBlob); // Update state with the OPUS blob

            // Create URL for playback
            const url = URL.createObjectURL(opusBlob);
            setAudioUrl(url);

            // Call callback with the OPUS blob for upload
            if (onRecordingComplete) {
              onRecordingComplete(opusBlob, url);
            }
            setError(''); // Clear conversion message
          } catch (convertError) {
            console.error('Failed to convert to OPUS:', convertError);
            setError('Failed to convert audio to OPUS: ' + convertError.message);
          } finally {
            setIsConverting(false); // Conversion finished
          }
        };

        mediaRecorderRef.current.onerror = (event) => {
          console.error('MediaRecorder error:', event.error);
          setError('Recording failed: ' + event.error.message);
        };

        // Start recording
        mediaRecorderRef.current.start(1000); // Collect data every second
        setIsRecording(true);
        setRecordingTime(0);

        // Start timer
        timerRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);

        console.log('Recording started with MIME type:', mediaRecorderRef.current.mimeType);
      } catch (error) {
        console.error('Failed to start recording:', error);
        setError('Failed to start recording: ' + error.message);
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

    // Start playback
    const startPlayback = () => {
      if (audioRef.current && audioUrl) {
        audioRef.current.play();
        setIsPlaying(true);
        setPlaybackTime(0);

        // Start playback timer
        playbackTimerRef.current = setInterval(() => {
          if (audioRef.current) {
            setPlaybackTime(Math.floor(audioRef.current.currentTime));
          }
        }, 1000);
      }
    };

    // Stop playback
    const stopPlayback = () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setIsPlaying(false);
      setPlaybackTime(0);

      if (playbackTimerRef.current) {
        clearInterval(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
    };

    // Format time display
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // Handle audio ended
    const handleAudioEnded = () => {
      setIsPlaying(false);
      setPlaybackTime(0);
      if (playbackTimerRef.current) {
        clearInterval(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
    };

    // Cleanup on unmount (kept from original, ensured FFmpeg is loaded for cleanup as well)
    useEffect(() => {
      const currentFFmpeg = ffmpegRef.current;
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
        }
        if (audioUrl) {
          URL.revokeObjectURL(audioUrl);
        }
        // You might want to terminate FFmpeg worker if it's running
        // currentFFmpeg.terminate(); // Uncomment if you want to explicitly terminate
      };
    }, [audioUrl]);


    const buttonStyle = {
      padding: '12px 24px',
      margin: '5px',
      border: 'none',
      borderRadius: '8px',
      fontSize: '16px',
      fontWeight: 'bold',
      cursor: 'pointer',
      transition: 'all 0.2s ease',
    };

    const recordButtonStyle = {
      ...buttonStyle,
      backgroundColor: isRecording ? '#ff4444' : '#4CAF50',
      color: 'white',
    };

    const playButtonStyle = {
      ...buttonStyle,
      backgroundColor: isPlaying ? '#ff4444' : '#2196F3',
      color: 'white',
    };

    return (
      <div style={{ padding: '20px', maxWidth: '400px', margin: '0 auto' }}>
        <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>
          Web Voice Recorder
        </h2>

        {(error || isConverting) && ( // Display conversion status or errors
          <div style={{
            color: isConverting ? '#2196F3' : '#ff4444',
            backgroundColor: isConverting ? '#e6f3ff' : '#ffe6e6',
            padding: '10px',
            borderRadius: '5px',
            marginBottom: '20px',
            textAlign: 'center'
          }}>
            {error || 'Converting...'}
          </div>
        )}

        {/* Recording section */}
        <div style={{ marginBottom: '20px', textAlign: 'center' }}>
          <div style={{ marginBottom: '10px', fontSize: '18px' }}>
            Recording Time: {formatTime(recordingTime)}
          </div>

          <button
            style={recordButtonStyle}
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!!error || isConverting || !ffmpegRef.current.loaded} // Disable if FFmpeg not loaded
          >
            {isRecording ? '⏹ Stop Recording' : '🎤 Start Recording'}
          </button>
        </div>

        {/* Playback section */}
        {audioUrl && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: '10px', fontSize: '18px' }}>
              Playback Time: {formatTime(playbackTime)}
            </div>

            <button
              style={playButtonStyle}
              onClick={isPlaying ? stopPlayback : startPlayback}
              disabled={isConverting} // Disable playback during conversion
            >
              {isPlaying ? '⏹ Stop Playing' : '▶ Play Recording'}
            </button>

            <audio
              ref={audioRef}
              src={audioUrl}
              onEnded={handleAudioEnded}
              style={{ display: 'none' }}
            />

            <div style={{
              marginTop: '15px',
              fontSize: '12px',
              color: '#666',
              wordBreak: 'break-all'
            }}>
              <strong>File info:</strong><br/>
              Type: {audioBlob?.type || 'Unknown'}<br/>
              Size: {audioBlob ? Math.round(audioBlob.size / 1024) : 0} KB
            </div>
          </div>
        )}
      </div>
    );
  };

  export default WebVoiceRecorder;