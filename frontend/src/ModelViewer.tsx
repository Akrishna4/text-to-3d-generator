/**
 * ModelViewer.tsx
 * ---------------
 * React Three Fiber canvas that loads and displays a GLB model.
 *
 * Lighting (no Environment preset — works fully offline):
 *   - HemisphereLight: sky/ground fill, warm-grey studio feel
 *   - DirectionalLight: soft key from upper-left
 *   - DirectionalLight: soft fill from lower-right (reduces harsh shadows)
 *
 * Features:
 *   - Bounds + useBounds().fit() auto-frames any model size
 *   - OrbitControls with damping; autoRotate stops on user interaction
 *   - ContactShadows for soft ground contact (no Grid — cleaner look)
 *   - Suspense fallback: subtle wireframe cube while GLB streams in
 *   - onInteract callback fires once when the user first touches the scene
 */

import { Suspense, useEffect, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import {
  OrbitControls,
  useGLTF,
  ContactShadows,
  Center,
  Bounds,
  useBounds,
} from '@react-three/drei'
import * as THREE from 'three'

// ── Inner model ───────────────────────────────────────────────────────────────

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const bounds = useBounds()

  useEffect(() => {
    bounds.refresh().fit()
    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
  }, [url, scene, bounds])

  return <primitive object={scene} />
}

// ── Suspense wireframe placeholder ────────────────────────────────────────────

function LoadingFallback() {
  return (
    <mesh>
      <boxGeometry args={[0.4, 0.4, 0.4]} />
      <meshStandardMaterial color="#9B9890" wireframe />
    </mesh>
  )
}

// ── Public component ──────────────────────────────────────────────────────────

interface ModelViewerProps {
  /** Relative URL to the GLB file, e.g. "/api/models/<id>.glb" */
  modelUrl: string
  /** Called the first time the user interacts with the scene */
  onInteract?: () => void
}

export function ModelViewer({ modelUrl, onInteract }: ModelViewerProps) {
  const interactedRef = useRef(false)

  const handleInteract = () => {
    if (!interactedRef.current) {
      interactedRef.current = true
      onInteract?.()
    }
  }

  return (
    <Canvas
      shadows
      camera={{ position: [0, 1.5, 4], fov: 42 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent' }}
      onPointerDown={handleInteract}
      onWheel={handleInteract}
    >
      {/*
        HemisphereLight: warm sky / cool ground fill.
        Gives the untextured white mesh a subtle tonal gradient.
      */}
      <hemisphereLight
        args={['#EDE9E0', '#B8B4AA', 0.7]}
      />

      {/* Key light — soft from upper-left, casts gentle shadows */}
      <directionalLight
        position={[-4, 6, 4]}
        intensity={1.1}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
      />

      {/* Fill light — opposite side, lower intensity, no shadows */}
      <directionalLight
        position={[4, 2, -4]}
        intensity={0.35}
      />

      {/*
        Bounds: wraps the model so useBounds().fit() auto-frames it.
        damping: smooth camera transition; clip: adjusts near/far planes.
      */}
      <Bounds fit clip margin={1.25}>
        <Suspense fallback={<LoadingFallback />}>
          <Center>
            <Model url={modelUrl} />
          </Center>
        </Suspense>
      </Bounds>

      {/* Soft contact shadow — no Grid keeps the backdrop clean */}
      <ContactShadows
        position={[0, -1.6, 0]}
        opacity={0.32}
        scale={12}
        blur={3}
        far={5}
        color="#6B6560"
      />

      {/*
        OrbitControls:
          autoRotate: slow idle spin (demo mode)
          enableDamping: smooth friction feel
          The onStart prop (fires on any control interaction) stops auto-rotate
          by toggling a state, but since autoRotate re-enables on unmount we
          instead handle this via the onInteract callback passed from App.
      */}
      <OrbitControls
        enableDamping
        dampingFactor={0.06}
        minDistance={0.5}
        maxDistance={20}
        autoRotate
        autoRotateSpeed={0.5}
        onStart={handleInteract}
      />
    </Canvas>
  )
}
