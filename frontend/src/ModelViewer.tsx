/**
 * ModelViewer.tsx
 * ---------------
 * React Three Fiber canvas that loads and displays a GLB model.
 *
 * Features:
 *   - OrbitControls: rotate (drag), zoom (scroll), pan (right-drag)
 *   - Auto-fits camera to the model's bounding box so any size model fills view
 *   - Environment lighting (studio preset) + contact shadow for realism
 *   - Grid floor plane for spatial grounding
 *   - Suspense fallback shows a spinner while the GLB loads
 */

import { Suspense, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import {
  OrbitControls,
  useGLTF,
  Environment,
  ContactShadows,
  Grid,
  Center,
  Bounds,
  useBounds,
} from '@react-three/drei'
import * as THREE from 'three'

// ── Inner model component ─────────────────────────────────────────────────────

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const bounds = useBounds()

  useEffect(() => {
    // Fit the camera to the model's bounding box after it loads.
    // useBounds().refresh().fit() computes the AABB and moves the camera.
    bounds.refresh().fit()

    // Enable shadow casting/receiving on all meshes
    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
  }, [url, scene, bounds])

  return <primitive object={scene} />
}

// ── Loading fallback ──────────────────────────────────────────────────────────

function LoadingFallback() {
  return (
    <mesh>
      <boxGeometry args={[0.5, 0.5, 0.5]} />
      <meshStandardMaterial color="#7c6cfc" wireframe />
    </mesh>
  )
}

// ── Public component ──────────────────────────────────────────────────────────

interface ModelViewerProps {
  /** Full URL to the GLB file, e.g. "/api/models/<id>.glb" */
  modelUrl: string
}

export function ModelViewer({ modelUrl }: ModelViewerProps) {
  return (
    <Canvas
      shadows
      camera={{ position: [0, 1.5, 4], fov: 45 }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: 'transparent' }}
    >
      {/* Ambient + directional light for base illumination */}
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[5, 8, 5]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />

      {/* Environment map gives realistic reflections on metallic/glossy surfaces */}
      <Environment preset="studio" />

      {/*
        Bounds wraps the model so useBounds().fit() can auto-frame it.
        damping: smooth camera transition when fitting.
        clip: adjust near/far planes to match model size.
      */}
      <Bounds fit clip margin={1.2}>
        <Suspense fallback={<LoadingFallback />}>
          <Center>
            <Model url={modelUrl} />
          </Center>
        </Suspense>
      </Bounds>

      {/* Soft contact shadow below the model */}
      <ContactShadows
        position={[0, -1.5, 0]}
        opacity={0.5}
        scale={10}
        blur={2.5}
        far={4}
        color="#000"
      />

      {/* Grid floor */}
      <Grid
        position={[0, -1.51, 0]}
        args={[20, 20]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#1c1f2e"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#252840"
        fadeDistance={15}
        fadeStrength={1}
        followCamera={false}
        infiniteGrid
      />

      {/*
        OrbitControls: rotate on left-drag, zoom on scroll, pan on right-drag.
        enableDamping gives a smooth "friction" feel.
        autoRotate gives a gentle spin when idle — nice for demo mode.
      */}
      <OrbitControls
        enableDamping
        dampingFactor={0.05}
        minDistance={0.5}
        maxDistance={20}
        autoRotate
        autoRotateSpeed={0.6}
      />
    </Canvas>
  )
}
