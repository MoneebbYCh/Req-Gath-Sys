import { type ReactNode } from 'react'

interface CRTMonitorProps {
  children: ReactNode
}

export function CRTMonitor({ children }: CRTMonitorProps) {
  return (
    <>
      <div className="crt-scanlines" />
      <div className="crt-glow" />
      <div className="crt-reflex" />
      {children}
    </>
  )
}
