/** Shared user profile for home + profile page. */

export const PROFILE_KEY = 'charter-ai-profile-v1'

export interface UserProfile {
  name: string
  role: string
  email: string
  org: string
  bio: string
}

export const DEFAULT_PROFILE: UserProfile = {
  name: 'Your name',
  role: 'Project lead',
  email: 'you@example.com',
  org: 'Your company',
  bio: 'Authorizing work one charter at a time.',
}

export function loadProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return { ...DEFAULT_PROFILE }
    const parsed = JSON.parse(raw) as Partial<UserProfile>
    return {
      name: String(parsed.name || DEFAULT_PROFILE.name).trim() || DEFAULT_PROFILE.name,
      role: String(parsed.role || DEFAULT_PROFILE.role).trim() || DEFAULT_PROFILE.role,
      email: String(parsed.email || DEFAULT_PROFILE.email).trim() || DEFAULT_PROFILE.email,
      org: String(parsed.org || DEFAULT_PROFILE.org).trim() || DEFAULT_PROFILE.org,
      bio: String(parsed.bio || DEFAULT_PROFILE.bio).trim() || DEFAULT_PROFILE.bio,
    }
  } catch {
    return { ...DEFAULT_PROFILE }
  }
}

export function saveProfile(profile: UserProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
}

export function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
}
