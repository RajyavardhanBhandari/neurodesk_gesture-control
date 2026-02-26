import { useEffect, useMemo, useRef, useState } from "react";

type CursorPoint = {
  x: number;
  y: number;
};

type Tile = {
  id: string;
  title: string;
  detail: string;
};

type GestureExample = {
  name: string;
  gesture: string;
  output: string;
};

type GestureMode = "idle" | "pointer" | "click" | "scroll" | "zoom" | "swipe";

declare global {
  interface Window {
    Hands?: any;
  }
}

const INITIAL_TILES: Tile[] = [
  { id: "mail", title: "Mail", detail: "Unread: 12" },
  { id: "media", title: "Media", detail: "Now Playing" },
  { id: "tasks", title: "Tasks", detail: "3 due today" },
  { id: "notes", title: "Notes", detail: "Gesture ideas" },
  { id: "stats", title: "Stats", detail: "Realtime mode" },
  { id: "lights", title: "Lights", detail: "Studio scene" },
  { id: "code", title: "Code", detail: "Review queue" },
  { id: "boards", title: "Boards", detail: "Sprint planning" },
  { id: "docs", title: "Docs", detail: "AI spec draft" },
  { id: "music", title: "Music", detail: "Focus playlist" },
  { id: "camera", title: "Camera", detail: "Rear feed" },
  { id: "chat", title: "Chat", detail: "4 active rooms" },
];

const EXAMPLES: GestureExample[] = [
  { name: "Precision Select", gesture: "Index + thumb pinch", output: "Open focused tile" },
  { name: "Timeline Scroll", gesture: "Index + middle together", output: "Vertical timeline control" },
  { name: "Thumb-Middle Zoom", gesture: "Thumb + middle pinch distance", output: "Zoom in / zoom out" },
  { name: "Air Swipe", gesture: "Fast horizontal index flick", output: "Cycle tile focus" },
  { name: "Drag & Arrange", gesture: "Hold pinch > 0.5 sec", output: "Reorder workspace cards" },
  { name: "Auto Click", gesture: "Hover on tile for 1 sec", output: "Hands-free dwell click" },
];

const HANDS_SCRIPT = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.min.js";

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<any>(null);
  const processingRef = useRef(false);
  const pinchStateRef = useRef(false);
  const clickCooldownRef = useRef(0);
  const pinchFramesRef = useRef(0);
  const scrollFramesRef = useRef(0);
  const zoomFramesRef = useRef(0);
  const scrollReleaseFramesRef = useRef(0);
  const zoomReleaseFramesRef = useRef(0);
  const scrollModeRef = useRef(false);
  const zoomModeRef = useRef(false);
  const dragFramesRef = useRef(0);
  const dragSwapCooldownRef = useRef(0);
  const dragTargetRef = useRef<string | null>(null);
  const pinchStartTimeRef = useRef(0);
  const zoomStateRef = useRef<{ lastDistance: number } | null>(null);
  const scrollAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const previousPointRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeCooldownRef = useRef(0);
  const dwellRef = useRef<{ id: string | null; startedAt: number }>({ id: null, startedAt: 0 });

  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [status, setStatus] = useState("Enable your camera to start gesture control.");
  const [tiles, setTiles] = useState(INITIAL_TILES);
  const [cursor, setCursor] = useState<CursorPoint>({ x: 0.5, y: 0.5 });
  const [handVisible, setHandVisible] = useState(false);
  const [pinching, setPinching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gestureMode, setGestureMode] = useState<GestureMode>("idle");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollOffsetX, setScrollOffsetX] = useState(0);
  const [dwellProgress, setDwellProgress] = useState(0);
  const [pinchMetric, setPinchMetric] = useState(0);
  const [velocityMetric, setVelocityMetric] = useState(0);
  const [swipePulse, setSwipePulse] = useState(0);
  const [activeTile, setActiveTile] = useState<string | null>(null);

  const activeTileData = useMemo(() => tiles.find((tile) => tile.id === activeTile), [tiles, activeTile]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      if (handsRef.current?.close) {
        handsRef.current.close();
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const loadHandsScript = () =>
    new Promise<void>((resolve, reject) => {
      if (window.Hands) {
        resolve();
        return;
      }

      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${HANDS_SCRIPT}"]`);
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Failed to load hand tracking script.")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = HANDS_SCRIPT;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load hand tracking script."));
      document.body.appendChild(script);
    });

  const getTileAtCursor = (nextCursor: CursorPoint) => {
    const screen = screenRef.current;
    if (!screen) {
      return null;
    }

    const rect = screen.getBoundingClientRect();
    const absoluteX = rect.left + rect.width * nextCursor.x;
    const absoluteY = rect.top + rect.height * nextCursor.y;
    const elements = Array.from(screen.querySelectorAll<HTMLElement>("[data-tile-id]"));

    const target = elements.find((element) => {
      const tileRect = element.getBoundingClientRect();
      return absoluteX >= tileRect.left && absoluteX <= tileRect.right && absoluteY >= tileRect.top && absoluteY <= tileRect.bottom;
    });

    return target?.dataset.tileId ?? null;
  };

  const triggerTileClick = (nextCursor: CursorPoint, source: "pinch" | "dwell") => {
    const tileId = getTileAtCursor(nextCursor);
    if (!tileId) {
      return;
    }

    setActiveTile((current) => (current === tileId ? null : tileId));
    setStatus(`${source === "pinch" ? "Pinch" : "Dwell"} click: ${tileId.toUpperCase()} toggled.`);
  };

  const reorderTiles = (fromId: string, toId: string) => {
    if (fromId === toId) {
      return;
    }

    setTiles((current) => {
      const fromIndex = current.findIndex((tile) => tile.id === fromId);
      const toIndex = current.findIndex((tile) => tile.id === toId);
      if (fromIndex < 0 || toIndex < 0) {
        return current;
      }

      const cloned = [...current];
      const [moved] = cloned.splice(fromIndex, 1);
      cloned.splice(toIndex, 0, moved);
      return cloned;
    });
  };

  const triggerSwipeSelect = (direction: "left" | "right") => {
    setActiveTile((current) => {
      const currentIndex = tiles.findIndex((tile) => tile.id === current);
      const safeIndex = currentIndex === -1 ? 0 : currentIndex;
      const delta = direction === "right" ? 1 : -1;
      const nextIndex = (safeIndex + delta + tiles.length) % tiles.length;
      return tiles[nextIndex].id;
    });

    setSwipePulse((count) => count + 1);
    setGestureMode("swipe");
    setStatus(`Air swipe ${direction}: switched tile focus.`);
  };

  const drawHandGuide = (landmarks: Array<{ x: number; y: number }> | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) {
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return;
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, width, height);
    if (!landmarks) {
      return;
    }

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "rgba(56, 189, 248, 0.9)");
    gradient.addColorStop(1, "rgba(45, 212, 191, 0.9)");

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.25;
    ctx.shadowColor = "rgba(45, 212, 191, 0.7)";
    ctx.shadowBlur = 12;

    HAND_CONNECTIONS.forEach(([from, to]) => {
      const start = landmarks[from];
      const end = landmarks[to];
      if (!start || !end) {
        return;
      }

      ctx.beginPath();
      ctx.moveTo((1 - start.x) * width, start.y * height);
      ctx.lineTo((1 - end.x) * width, end.y * height);
      ctx.stroke();
    });

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(186, 230, 253, 0.95)";

    landmarks.forEach((point) => {
      const x = (1 - point.x) * width;
      const y = point.y * height;
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    });

    const indexTip = landmarks[8];
    const thumbTip = landmarks[4];
    if (indexTip && thumbTip) {
      ctx.strokeStyle = "rgba(244, 244, 245, 0.9)";
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo((1 - indexTip.x) * width, indexTip.y * height);
      ctx.lineTo((1 - thumbTip.x) * width, thumbTip.y * height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  };

  const startGestureEngine = async () => {
    try {
      setStatus("Requesting camera access...");

      await loadHandsScript();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: "user" },
        audio: false,
      });

      const video = videoRef.current;
      if (!video) {
        throw new Error("Camera element is not available.");
      }

      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();

      const hands = new window.Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.72,
        minTrackingConfidence: 0.7,
      });

      hands.onResults((results: any) => {
        const handLandmarks = results.multiHandLandmarks?.[0] ?? null;
        drawHandGuide(handLandmarks);

        if (!handLandmarks) {
          setHandVisible(false);
          setPinching(false);
          setDragging(false);
          setGestureMode("idle");
          setDwellProgress(0);
          setVelocityMetric(0);
          pinchStateRef.current = false;
          pinchFramesRef.current = 0;
          scrollFramesRef.current = 0;
          zoomFramesRef.current = 0;
          scrollReleaseFramesRef.current = 0;
          zoomReleaseFramesRef.current = 0;
          scrollModeRef.current = false;
          zoomModeRef.current = false;
          dragFramesRef.current = 0;
          dragTargetRef.current = null;
          pinchStartTimeRef.current = 0;
          zoomStateRef.current = null;
          scrollAnchorRef.current = null;
          previousPointRef.current = null;
          dwellRef.current = { id: null, startedAt: 0 };
          setStatus("Hand not detected. Keep your hand in frame.");
          return;
        }

        const indexTip = handLandmarks[8];
        const thumbTip = handLandmarks[4];
        const middleTip = handLandmarks[12];
        if (!indexTip || !thumbTip) {
          return;
        }

        setHandVisible(true);
        const nextCursor = {
          x: clamp(1 - indexTip.x, 0, 1),
          y: clamp(indexTip.y, 0, 1),
        };

        const now = performance.now();
        const wrist = handLandmarks[0];
        const indexBase = handLandmarks[5];
        const pinkyBase = handLandmarks[17];
        const palmScale = Math.max(distance(indexBase, pinkyBase), distance(wrist, handLandmarks[9]), 0.08);
        const normalizedDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => distance(a, b) / palmScale;

        const pinchDistance = normalizedDistance(indexTip, thumbTip);
        const middleThumbDistance = middleTip ? normalizedDistance(middleTip, thumbTip) : 1;
        const normalizedIndexMiddle = middleTip ? normalizedDistance(indexTip, middleTip) : 1;

        const previousPoint = previousPointRef.current;
        const dt = previousPoint ? now - previousPoint.t : 16;
        const velocity = previousPoint ? Math.hypot(nextCursor.x - previousPoint.x, nextCursor.y - previousPoint.y) / Math.max(dt, 1) : 0;
        setVelocityMetric(clamp(velocity * 900, 0, 1));

        const smooth = clamp(0.22 + velocity * 1.8, 0.22, 0.56);
        const stableCursor = previousPoint
          ? {
              x: previousPoint.x * (1 - smooth) + nextCursor.x * smooth,
              y: previousPoint.y * (1 - smooth) + nextCursor.y * smooth,
            }
          : nextCursor;

        setCursor(stableCursor);

        const scrollStart = normalizedIndexMiddle < 0.22 && middleThumbDistance > 0.34;
        const scrollHold = normalizedIndexMiddle < 0.3 && middleThumbDistance > 0.28;
        const zoomStart = middleThumbDistance < 0.24 && normalizedIndexMiddle > 0.25;
        const zoomHold = middleThumbDistance < 0.34 && normalizedIndexMiddle > 0.2;

        if (zoomModeRef.current) {
          if (zoomHold) {
            zoomReleaseFramesRef.current = 0;
          } else {
            zoomReleaseFramesRef.current += 1;
          }

          if (zoomReleaseFramesRef.current > 5) {
            zoomModeRef.current = false;
            zoomReleaseFramesRef.current = 0;
            zoomStateRef.current = null;
          }
        } else if (!scrollModeRef.current && zoomStart) {
          zoomFramesRef.current += 1;
          if (zoomFramesRef.current >= 3) {
            zoomModeRef.current = true;
            zoomFramesRef.current = 0;
          }
        } else {
          zoomFramesRef.current = 0;
        }

        if (scrollModeRef.current) {
          if (scrollHold) {
            scrollReleaseFramesRef.current = 0;
          } else {
            scrollReleaseFramesRef.current += 1;
          }

          if (scrollReleaseFramesRef.current > 5) {
            scrollModeRef.current = false;
            scrollReleaseFramesRef.current = 0;
            scrollAnchorRef.current = null;
          }
        } else if (!zoomModeRef.current && scrollStart) {
          scrollFramesRef.current += 1;
          if (scrollFramesRef.current >= 3) {
            scrollModeRef.current = true;
            scrollFramesRef.current = 0;
          }
        } else {
          scrollFramesRef.current = 0;
        }

        const zoomGesture = zoomModeRef.current;
        const scrollGesture = scrollModeRef.current;

        const pinchStartThreshold = 0.34;
        const pinchHoldThreshold = 0.42;
        const nextPinch = (pinchStateRef.current ? pinchDistance < pinchHoldThreshold : pinchDistance < pinchStartThreshold) && !scrollGesture && !zoomGesture;
        const wasPinching = pinchStateRef.current;
        pinchFramesRef.current = nextPinch ? pinchFramesRef.current + 1 : 0;
        setPinchMetric(clamp(1 - pinchDistance / 0.65, 0, 1));

        setPinching(nextPinch);

        if (nextPinch && !wasPinching) {
          pinchStartTimeRef.current = now;
        }

        if (zoomGesture) {
          setGestureMode("zoom");
          const base = zoomStateRef.current;
          if (!base) {
            zoomStateRef.current = { lastDistance: middleThumbDistance };
          } else {
            const delta = middleThumbDistance - base.lastDistance;
            if (Math.abs(delta) > 0.0012) {
              setZoomLevel((current) => clamp(current + delta * 3.6, 0.45, 2.6));
            }
            zoomStateRef.current = {
              lastDistance: base.lastDistance * 0.45 + middleThumbDistance * 0.55,
            };
          }
          scrollAnchorRef.current = null;
          scrollModeRef.current = false;
          setDragging(false);
          dragFramesRef.current = 0;
          setDwellProgress(0);
          setStatus("Zoom mode: thumb + middle closer = zoom in, farther apart = zoom out.");
        } else {
          zoomStateRef.current = null;
        }

        if (scrollGesture && middleTip) {
          setGestureMode("scroll");
          const midpointY = (indexTip.y + middleTip.y) * 0.5;
          const midpointX = (indexTip.x + middleTip.x) * 0.5;
          if (scrollAnchorRef.current === null) {
            scrollAnchorRef.current = { x: midpointX, y: midpointY };
          } else {
            const deltaY = midpointY - scrollAnchorRef.current.y;
            const deltaX = scrollAnchorRef.current.x - midpointX;
            const easedStepY = clamp(deltaY * 180, -22, 22);
            const easedStepX = clamp(deltaX * 180, -22, 22);
            setScrollOffset((current) => clamp(current + easedStepY, -360, 360));
            setScrollOffsetX((current) => clamp(current + easedStepX, -360, 360));
            scrollAnchorRef.current = {
              x: scrollAnchorRef.current.x * 0.65 + midpointX * 0.35,
              y: scrollAnchorRef.current.y * 0.65 + midpointY * 0.35,
            };
          }
          zoomModeRef.current = false;
          setDragging(false);
          dragFramesRef.current = 0;
          setDwellProgress(0);
          setStatus("Scroll mode: keep index + middle together, move up/down and left/right.");
        } else {
          scrollAnchorRef.current = null;
        }

        if (nextPinch && !zoomGesture && !scrollGesture) {
          dragFramesRef.current += 1;
        } else {
          dragFramesRef.current = 0;
          dragTargetRef.current = null;
          setDragging(false);
        }

        if (dragFramesRef.current > 12 && activeTile) {
          setDragging(true);
          setGestureMode("pointer");
          const hoverTile = getTileAtCursor(stableCursor);
          if (hoverTile && hoverTile !== activeTile && hoverTile !== dragTargetRef.current && now - dragSwapCooldownRef.current > 280) {
            reorderTiles(activeTile, hoverTile);
            dragTargetRef.current = hoverTile;
            dragSwapCooldownRef.current = now;
            setStatus(`Dragging ${activeTile.toUpperCase()} over ${hoverTile.toUpperCase()}.`);
          }
        }

        if (!nextPinch && wasPinching) {
          const pinchDuration = now - pinchStartTimeRef.current;
          const shouldClick =
            pinchDuration < 280 &&
            !scrollGesture &&
            !zoomGesture &&
            now - clickCooldownRef.current > 420;

          if (shouldClick) {
            setGestureMode("click");
            triggerTileClick(stableCursor, "pinch");
            clickCooldownRef.current = now;
            setDwellProgress(0);
          }
        }

        if (!nextPinch && !scrollGesture && !zoomGesture) {
          setGestureMode("pointer");
          setStatus("Pointer mode: steer with your index finger.");

          if (previousPoint) {
            const dx = stableCursor.x - previousPoint.x;
            if (dt < 135 && Math.abs(dx) > 0.22 && now - swipeCooldownRef.current > 650) {
              triggerSwipeSelect(dx > 0 ? "right" : "left");
              swipeCooldownRef.current = now;
            }
          }

          const hoveredTile = getTileAtCursor(stableCursor);
          if (hoveredTile) {
            if (dwellRef.current.id !== hoveredTile) {
              dwellRef.current = { id: hoveredTile, startedAt: now };
              setDwellProgress(0);
            } else {
              const progress = clamp((now - dwellRef.current.startedAt) / 980, 0, 1);
              setDwellProgress(progress);
              if (progress >= 1 && now - clickCooldownRef.current > 600) {
                triggerTileClick(stableCursor, "dwell");
                clickCooldownRef.current = now;
                dwellRef.current = { id: hoveredTile, startedAt: now };
                setDwellProgress(0);
              }
            }
          } else {
            dwellRef.current = { id: null, startedAt: 0 };
            setDwellProgress(0);
          }
        }

        previousPointRef.current = { x: stableCursor.x, y: stableCursor.y, t: now };
        pinchStateRef.current = nextPinch;
      });

      handsRef.current = hands;

      const renderFrame = async () => {
        if (!videoRef.current || !handsRef.current) {
          return;
        }

        if (!processingRef.current) {
          processingRef.current = true;
          await handsRef.current.send({ image: videoRef.current });
          processingRef.current = false;
        }

        animationFrameRef.current = requestAnimationFrame(renderFrame);
      };

      animationFrameRef.current = requestAnimationFrame(renderFrame);
      setCameraEnabled(true);
      setGestureMode("pointer");
      setStatus("Camera ready. Raise one hand and point with your index finger.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to start camera.");
      setCameraEnabled(false);
    }
  };

  return (
    <main className="tech-shell min-h-screen px-4 py-8 sm:px-8">
      <section className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5 rounded-[28px] border border-cyan-100/20 bg-slate-950/55 p-5 shadow-2xl backdrop-blur-xl sm:p-7">
          <header className="space-y-2">
            <p className="text-xs uppercase tracking-[0.34em] text-cyan-300">NeuroDesk Control</p>
            <h1 className="font-display text-3xl text-white sm:text-5xl">Control your screen with hand gestures</h1>
            <p className="max-w-2xl text-sm text-slate-200 sm:text-base">
              Pointer, pinch click, dwell click, drag-to-reorder, index-middle vertical scroll, thumb-middle pinch zoom, and air-swipe
              switching in one
              real-time gesture cockpit.
            </p>
          </header>

          <div
            ref={screenRef}
            className="relative overflow-hidden rounded-3xl border border-cyan-100/20 bg-gradient-to-br from-slate-900 via-cyan-950 to-emerald-950 p-4 sm:p-6"
          >
            <div className="grid-overlay pointer-events-none absolute inset-0" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(125,211,252,0.24),transparent_35%),radial-gradient(circle_at_82%_82%,rgba(16,185,129,0.2),transparent_30%)]" />
            <div
              className="relative grid gap-3 transition-transform duration-150 sm:grid-cols-3"
              style={{ transform: `translate(${scrollOffsetX}px, ${scrollOffset}px) scale(${zoomLevel})`, transformOrigin: "center 30%" }}
            >
              {tiles.map((tile) => {
                const selected = activeTile === tile.id;
                return (
                  <article
                    key={tile.id}
                    data-tile-id={tile.id}
                    className={`rounded-2xl border p-4 transition ${
                      selected
                        ? "border-emerald-200 bg-emerald-100/90 text-emerald-950 shadow-[0_0_0_1px_rgba(16,185,129,0.5),0_16px_30px_rgba(16,185,129,0.3)]"
                        : "border-cyan-200/30 bg-white/10 text-cyan-50"
                    }`}
                  >
                    <h2 className="text-sm font-semibold uppercase tracking-wide">{tile.title}</h2>
                    <p className="mt-2 text-xs opacity-90">{tile.detail}</p>
                    <div className="mt-3 h-1.5 rounded-full bg-black/20">
                      <div className="h-full w-2/3 rounded-full bg-cyan-300/80" />
                    </div>
                  </article>
                );
              })}
            </div>

            <div
              className="pointer-events-none absolute z-20 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 shadow-[0_0_0_6px_rgba(56,189,248,0.22),0_0_24px_rgba(45,212,191,0.45)] transition-transform"
              style={{
                left: `${cursor.x * 100}%`,
                top: `${cursor.y * 100}%`,
                background: pinching ? "#fbbf24" : "#22d3ee",
                transform: `translate(-50%, -50%) scale(${pinching ? 1.2 : 1})`,
              }}
            />
            <div
              className="pointer-events-none absolute z-10 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-200/40"
              style={{
                left: `${cursor.x * 100}%`,
                top: `${cursor.y * 100}%`,
                opacity: 0.25 + dwellProgress * 0.7,
                transform: `translate(-50%, -50%) scale(${1 + dwellProgress * 0.65})`,
              }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-cyan-100/20 to-transparent"
              key={swipePulse}
              style={{ left: "-20%", animation: "scanline 1.4s linear" }}
            />
          </div>
        </div>

        <aside className="space-y-5 rounded-[28px] border border-cyan-100/25 bg-slate-950/65 p-5 shadow-xl backdrop-blur-xl sm:p-6">
          <button
            type="button"
            onClick={startGestureEngine}
            disabled={cameraEnabled}
            className="w-full rounded-2xl bg-cyan-400/90 px-4 py-3 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-cyan-900 disabled:text-cyan-100"
          >
            {cameraEnabled ? "Tracking Live" : "Start Camera + Gesture Tracking"}
          </button>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Hand</p>
              <p className="mt-1 font-semibold text-slate-100">{handVisible ? "Detected" : "Not found"}</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Gesture</p>
              <p className="mt-1 font-semibold uppercase text-slate-100">{gestureMode}</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Zoom</p>
              <p className="mt-1 font-semibold text-slate-100">{Math.round(zoomLevel * 100)}%</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Scroll</p>
              <p className="mt-1 font-semibold text-slate-100">{Math.round(scrollOffset)} px</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Scroll X</p>
              <p className="mt-1 font-semibold text-slate-100">{Math.round(scrollOffsetX)} px</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Pinch power</p>
              <p className="mt-1 font-semibold text-slate-100">{Math.round(pinchMetric * 100)}%</p>
            </div>
            <div className="rounded-xl border border-cyan-100/20 bg-slate-900/70 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-300">Speed</p>
              <p className="mt-1 font-semibold text-slate-100">{Math.round(velocityMetric * 100)}%</p>
            </div>
          </div>

          <div className="rounded-2xl border border-cyan-100/20 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-cyan-200">Dwell click charge</p>
              <p className="text-xs text-cyan-100/80">{Math.round(dwellProgress * 100)}%</p>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-cyan-950/70">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300 transition-all" style={{ width: `${dwellProgress * 100}%` }} />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-stone-300 bg-stone-900">
            <div className="relative">
              <video ref={videoRef} muted playsInline className="h-52 w-full object-cover [transform:scaleX(-1)]" />
              <canvas
                ref={canvasRef}
                className="pointer-events-none absolute inset-0 h-full w-full [transform:scaleX(-1)]"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-cyan-100/20 bg-slate-900/80 p-4 text-sm text-slate-200">
            <p className="font-semibold text-cyan-200">Status</p>
            <p className="mt-1">{status}</p>
            {activeTileData ? (
              <p className="mt-3 rounded-lg bg-emerald-200/90 px-3 py-2 text-emerald-950">
                Selected: <strong>{activeTileData.title}</strong>
              </p>
            ) : null}
            {dragging ? <p className="mt-2 text-xs text-amber-200">Drag mode active: hold pinch and hover another tile to reorder.</p> : null}
            <ul className="mt-4 space-y-1 text-xs text-cyan-100/85">
              <li>- Quick pinch thumb + index: click/select</li>
              <li>- Hover for 1 second: dwell click</li>
              <li>- Keep index + middle together: vertical + horizontal scroll</li>
              <li>- Pinch middle + thumb: zoom in and zoom out</li>
              <li>- Fast index swipe: switch tiles</li>
              <li>- Hold pinch: drag and reorder tiles</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-cyan-100/20 bg-slate-900/80 p-4">
            <p className="text-sm font-semibold text-cyan-200">Expanded example profiles</p>
            <div className="mt-3 space-y-2">
              {EXAMPLES.map((example) => (
                <article key={example.name} className="rounded-lg border border-cyan-100/15 bg-slate-950/70 px-3 py-2">
                  <p className="text-xs uppercase tracking-wide text-cyan-300">{example.name}</p>
                  <p className="mt-1 text-xs text-slate-200">Gesture: {example.gesture}</p>
                  <p className="text-xs text-emerald-200">Action: {example.output}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-cyan-100/20 bg-slate-900/80 p-4 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Author</p>
            <p className="mt-2 font-semibold text-white">Rajyavardhan Bhandari</p>
            <p className="text-xs text-cyan-100">Founder and CEO, WebGravity Consulting Pvt Ltd</p>
            <a
              href="https://www.linkedin.com/in/rajyavardhan-bhandari/"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-xs font-semibold text-emerald-300 underline decoration-emerald-400/60 underline-offset-4"
            >
              LinkedIn: https://www.linkedin.com/in/rajyavardhan-bhandari/
            </a>
          </div>
        </aside>
      </section>
    </main>
  );
}
