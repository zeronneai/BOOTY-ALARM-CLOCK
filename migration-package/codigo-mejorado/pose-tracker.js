// pose-tracker.js — Tracker de pose moderno con MediaPipe Tasks Vision.
//
// Reemplaza la solución legacy @mediapipe/pose + el utilitario Camera.
// Arregla: librería deprecada (A1), fuga de memoria por no cerrar la instancia (A2),
// rendimiento sin control (A5).
//
// Instalación (proyecto nuevo):
//   npm i @mediapipe/tasks-vision
// y AUTO-HOSPEDA estos assets en /public (no dependas de un CDN externo):
//   - wasm:  node_modules/@mediapipe/tasks-vision/wasm/  -> /public/mediapipe/wasm/
//   - model: pose_landmarker_lite.task (o _full)        -> /public/mediapipe/pose_landmarker_lite.task
//
// Uso:
//   const tracker = new PoseTracker({ onResult, fps: 20 });
//   await tracker.start(videoEl);   // pide cámara + arranca el bucle
//   ...
//   await tracker.stop();           // libera cámara, modelo, WebGL y rVFC

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const DEFAULTS = {
  wasmPath: '/mediapipe/wasm',
  modelPath: '/mediapipe/pose_landmarker_lite.task',
  delegate: 'GPU',          // 'GPU' | 'CPU' — GPU es mucho más eficiente en batería
  numPoses: 1,
  minPoseDetectionConfidence: 0.6,
  minPosePresenceConfidence: 0.6,
  minTrackingConfidence: 0.6,
  fps: 20,                  // cap de inferencia; ahorra batería y evita backlog (A5)
};

export class PoseTracker {
  /**
   * @param {object}   opts
   * @param {(res) => void} opts.onResult  Recibe { landmarks, worldLandmarks, timestamp }
   *        - landmarks:      normalizados [0..1] (para dibujar sobre el video)
   *        - worldLandmarks: metros, origen en la cadera (para ángulos 3D anti-trampa)
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.landmarker = null;
    this.video = null;
    this.stream = null;
    this.running = false;
    this._rvfcHandle = null;
    this._busy = false;
    this._minFrameMs = 1000 / this.opts.fps;
    this._lastInfer = 0;
    this._onVisibility = this._onVisibility.bind(this);
  }

  /** Crea el modelo una sola vez. Reutilizable entre workouts. */
  async _ensureLandmarker() {
    if (this.landmarker) return;
    const fileset = await FilesetResolver.forVisionTasks(this.opts.wasmPath);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: this.opts.modelPath, delegate: this.opts.delegate },
      runningMode: 'VIDEO',
      numPoses: this.opts.numPoses,
      minPoseDetectionConfidence: this.opts.minPoseDetectionConfidence,
      minPosePresenceConfidence: this.opts.minPosePresenceConfidence,
      minTrackingConfidence: this.opts.minTrackingConfidence,
    });
  }

  /** Pide la cámara y arranca el bucle de inferencia. */
  async start(videoEl) {
    if (this.running) return;
    this.video = videoEl;
    await this._ensureLandmarker();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    this.running = true;
    document.addEventListener('visibilitychange', this._onVisibility);
    this._loop();
  }

  // Bucle basado en requestVideoFrameCallback: corre por frame de cámara real,
  // con cap de FPS y "frame dropping" si la inferencia anterior sigue en curso (A5).
  _loop() {
    if (!this.running || !this.video) return;
    const step = (_now, _meta) => {
      if (!this.running) return;
      const t = performance.now();
      const due = t - this._lastInfer >= this._minFrameMs;
      if (due && !this._busy && this.video.readyState >= 2) {
        this._busy = true;
        this._lastInfer = t;
        try {
          // detectForVideo es síncrono en Tasks Vision; el timestamp debe ser monótono.
          const res = this.landmarker.detectForVideo(this.video, t);
          const landmarks = res.landmarks?.[0] ?? null;
          const worldLandmarks = res.worldLandmarks?.[0] ?? null;
          if (landmarks) this.opts.onResult?.({ landmarks, worldLandmarks, timestamp: t });
        } catch (err) {
          console.warn('[PoseTracker] inferencia falló:', err);
        } finally {
          this._busy = false;
        }
      }
      this._rvfcHandle = this.video.requestVideoFrameCallback(step);
    };
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this._rvfcHandle = this.video.requestVideoFrameCallback(step);
    } else {
      // Fallback para navegadores sin rVFC.
      const raf = () => { if (this.running) { step(performance.now(), null); requestAnimationFrame(raf); } };
      requestAnimationFrame(raf);
    }
  }

  _onVisibility() {
    // Pausa la inferencia en background (no tiene sentido procesar oculto) y
    // la reanuda al volver. Evita timestamps no monótonos y ahorra batería.
    if (document.hidden) {
      this._busy = false;
    } else if (this.running && this.video?.paused) {
      this.video.play().catch(() => {});
    }
  }

  /**
   * Para el bucle y LIBERA TODO. Esto es lo que el código viejo no hacía (A2).
   * Llamar siempre al terminar el workout o al desmontar la pantalla.
   */
  async stop() {
    this.running = false;
    document.removeEventListener('visibilitychange', this._onVisibility);

    if (this._rvfcHandle && this.video?.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this._rvfcHandle); } catch {}
    }
    this._rvfcHandle = null;

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;   // libera la referencia al stream (el viejo no lo hacía)
      this.video = null;
    }
  }

  /**
   * Libera el modelo (WASM + contexto WebGL). Llamar al desmontar la app/feature.
   * Si vas a hacer muchos workouts seguidos, NO llames dispose() entre cada uno:
   * reutiliza la instancia y solo llama stop()/start(). dispose() es para el cierre final.
   */
  async dispose() {
    await this.stop();
    if (this.landmarker) {
      try { this.landmarker.close(); } catch (e) { console.warn('[PoseTracker] close falló:', e); }
      this.landmarker = null;
    }
  }
}
