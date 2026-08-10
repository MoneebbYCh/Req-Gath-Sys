import { useState } from 'react'
import type { View } from '../hooks/useViewState'
import {
  DEFAULT_PROFILE,
  loadProfile,
  profileInitials,
  saveProfile,
  type UserProfile,
} from '../utils/profile'

interface ProfilePageProps {
  onNavigate: (view: View) => void
  goHome: () => void
}

export function ProfilePage({ onNavigate, goHome }: ProfilePageProps) {
  const [profile, setProfile] = useState<UserProfile>(() => loadProfile())
  const [draft, setDraft] = useState<UserProfile>(() => loadProfile())
  const [savedFlash, setSavedFlash] = useState(false)

  const updateDraft = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    const next: UserProfile = {
      name: draft.name.trim() || DEFAULT_PROFILE.name,
      role: draft.role.trim() || DEFAULT_PROFILE.role,
      email: draft.email.trim() || DEFAULT_PROFILE.email,
      org: draft.org.trim() || DEFAULT_PROFILE.org,
      bio: draft.bio.trim() || DEFAULT_PROFILE.bio,
    }
    setProfile(next)
    setDraft(next)
    saveProfile(next)
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1600)
  }

  const handleReset = () => {
    setDraft({ ...DEFAULT_PROFILE })
  }

  return (
    <div className="home-desktop h-screen w-full overflow-hidden flex flex-col dither-bg">
      <div className="home-mac-window flex-1 min-h-0 m-2 md:m-3 border-2 border-on-background bg-white mac-window-shadow flex flex-col">
        <div className="flex items-center gap-2 border-b-2 border-on-background bg-secondary-container px-2 py-1 shrink-0">
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
          <span
            className="text-xs font-bold text-on-background px-2 whitespace-nowrap"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Profile Control Panel
          </span>
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
        </div>

        <div className="flex items-center justify-between gap-3 px-3 py-2 border-b-2 border-on-background bg-surface-container-low shrink-0">
          <button
            type="button"
            onClick={goHome}
            className="border-2 border-on-background bg-white text-on-background font-bold px-3 py-1 text-xs outset-button"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            ← Desktop
          </button>
          <span className="text-[11px] text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
            Dummy account · local only
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Identity card */}
            <aside className="lg:col-span-4 border-2 border-on-background bg-surface-container-low mac-window-shadow p-4">
              <div className="mac-striped-header border-b border-on-background mb-3" />
              <div className="flex flex-col items-center text-center gap-3">
                <span
                  className="w-20 h-20 border-2 border-on-background bg-primary text-on-primary flex items-center justify-center text-xl font-bold mac-window-shadow"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  {profileInitials(profile.name)}
                </span>
                <div>
                  <h1 className="text-xl font-extrabold text-on-background" style={{ fontFamily: 'var(--font-headline)' }}>
                    {profile.name}
                  </h1>
                  <p className="text-xs text-on-surface-variant mt-1" style={{ fontFamily: 'var(--font-label)' }}>
                    {profile.role}
                  </p>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">{profile.bio}</p>
                <div className="w-full border-2 border-on-background bg-white inset-field p-2 text-left">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1" style={{ fontFamily: 'var(--font-label)' }}>
                    Session (fake)
                  </div>
                  <ul className="text-[11px] space-y-1" style={{ fontFamily: 'var(--font-label)' }}>
                    <li>Last login: Today · 9:41 AM</li>
                    <li>Seat: Local workstation</li>
                    <li>Plan: Classic Mac Demo</li>
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate({ page: 'home' })}
                  className="w-full border-2 border-on-background bg-primary text-on-primary font-bold py-2 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Back to Home →
                </button>
              </div>
            </aside>

            {/* Editable dummy form */}
            <section className="lg:col-span-8 border-2 border-on-background bg-white mac-window-shadow p-4 md:p-5">
              <div className="flex items-center gap-2 mb-4">
                <span
                  className="text-xs font-bold tracking-widest text-on-surface-variant uppercase"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Account Settings
                </span>
                <div className="flex-1 h-px bg-on-background/30" />
                {savedFlash ? (
                  <span className="text-[11px] font-bold text-primary" style={{ fontFamily: 'var(--font-label)' }}>
                    Saved!
                  </span>
                ) : null}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                    Display name
                  </span>
                  <input
                    className="border-2 border-on-background bg-white px-2 py-1.5 text-sm inset-field"
                    value={draft.name}
                    onChange={(e) => updateDraft('name', e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                    Role
                  </span>
                  <input
                    className="border-2 border-on-background bg-white px-2 py-1.5 text-sm inset-field"
                    value={draft.role}
                    onChange={(e) => updateDraft('role', e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                    Email
                  </span>
                  <input
                    className="border-2 border-on-background bg-white px-2 py-1.5 text-sm inset-field"
                    value={draft.email}
                    onChange={(e) => updateDraft('email', e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                    Organization
                  </span>
                  <input
                    className="border-2 border-on-background bg-white px-2 py-1.5 text-sm inset-field"
                    value={draft.org}
                    onChange={(e) => updateDraft('org', e.target.value)}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 mb-4">
                <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                  About
                </span>
                <textarea
                  className="border-2 border-on-background bg-white px-2 py-1.5 text-sm inset-field min-h-[5rem] resize-y"
                  value={draft.bio}
                  onChange={(e) => updateDraft('bio', e.target.value)}
                />
              </label>

              <div className="border-2 border-on-background bg-surface-container-low inset-field p-3 mb-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-2" style={{ fontFamily: 'var(--font-label)' }}>
                  Preferences (placeholder)
                </div>
                <label className="flex items-center gap-2 text-xs mb-2" style={{ fontFamily: 'var(--font-label)' }}>
                  <input type="checkbox" defaultChecked className="accent-primary" />
                  Show CRT scanlines
                </label>
                <label className="flex items-center gap-2 text-xs mb-2" style={{ fontFamily: 'var(--font-label)' }}>
                  <input type="checkbox" defaultChecked className="accent-primary" />
                  Auto-save canvas drafts
                </label>
                <label className="flex items-center gap-2 text-xs" style={{ fontFamily: 'var(--font-label)' }}>
                  <input type="checkbox" className="accent-primary" />
                  Email me when a gate is ready (not wired)
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  className="border-2 border-on-background bg-primary text-on-primary font-bold px-5 py-1.5 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Save Profile
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="border-2 border-on-background bg-white font-bold px-4 py-1.5 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Reset Defaults
                </button>
                <button
                  type="button"
                  onClick={goHome}
                  className="border-2 border-on-background bg-secondary-container font-bold px-4 py-1.5 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Cancel
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
