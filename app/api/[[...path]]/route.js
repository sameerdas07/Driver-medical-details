import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function json(data, status = 200) { return NextResponse.json(data, { status }) }
function getToken(request) { const header = request.headers.get('authorization') || ''; return header.startsWith('Bearer ') ? header.slice(7) : null }
async function requireUser(request) {
  const token = getToken(request)
  if (!token) return { error: 'Please sign in first.', status: 401 }
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data?.user) return { error: 'Your session has expired. Please sign in again.', status: 401 }
  const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('id, email, full_name, role, approval_status').eq('id', data.user.id).maybeSingle()
  if (profileError) return { error: 'Please run the Supabase setup SQL before using the app.', status: 500 }
  return { user: data.user, profile }
}
function blocked(profile) {
  if (!profile) return json({ error: 'Account profile is not ready yet.' }, 403)
  if (profile.role !== 'admin' && profile.approval_status !== 'approved') return json({ error: 'Your account is waiting for admin approval.' }, 403)
  return null
}
function expiryFor(value) { const date = new Date(`${value}T00:00:00`); if (Number.isNaN(date.getTime())) return null; date.setMonth(date.getMonth() + 1); return date.toISOString().slice(0, 10) }

async function handleRoute(request, { params }) {
  const { path = [] } = await params
  const route = `/${path.join('/')}`
  const method = request.method
  try {
    if (route === '/root' || route === '/') return json({ message: 'Driver Data Hub API is running.' })
    if (route === '/signup' && method === 'POST') {
      const body = await request.json(); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || ''); const fullName = String(body.fullName || '').trim()
      if (!email || password.length < 6 || !fullName) return json({ error: 'Name, email, and a password of at least 6 characters are required.' }, 400)
      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
      if (createError) return json({ error: createError.message }, 400)
      const isAdmin = email === process.env.SUPABASE_ADMIN_EMAIL?.toLowerCase()
      const { error: profileError } = await supabaseAdmin.from('profiles').upsert({ id: created.user.id, email, full_name: fullName, role: isAdmin ? 'admin' : 'user', approval_status: isAdmin ? 'approved' : 'pending' })
      if (profileError) return json({ error: `Account created, but profile setup failed: ${profileError.message}` }, 500)
      return json({ message: 'Account created. Sign in after admin approval.', email })
    }
    const auth = await requireUser(request)
    if (route === '/me' && method === 'GET') { if (auth.error) return json({ error: auth.error }, auth.status); return json({ user: { id: auth.user.id, email: auth.user.email }, profile: auth.profile }) }
    if (route === '/profile' && method === 'POST') {
      if (auth.error) return json({ error: auth.error }, auth.status)
      const body = await request.json(); const email = (auth.user.email || '').toLowerCase(); const isAdmin = email === process.env.SUPABASE_ADMIN_EMAIL?.toLowerCase()
      const { data: profile, error } = await supabaseAdmin.from('profiles').upsert({ id: auth.user.id, email, full_name: String(body.fullName || auth.user.user_metadata?.full_name || email.split('@')[0]).trim(), role: isAdmin ? 'admin' : (auth.profile?.role || 'user'), approval_status: isAdmin ? 'approved' : (auth.profile?.approval_status || 'pending') }).select('id, email, full_name, role, approval_status').single()
      if (error) return json({ error: error.message }, 500); return json({ profile })
    }
    if (route === '/records' && (method === 'GET' || method === 'POST')) {
      if (auth.error) return json({ error: auth.error }, auth.status); const denial = blocked(auth.profile); if (denial) return denial
      if (method === 'GET') { const { data, error } = await supabaseAdmin.from('driver_records').select('*').order('created_at', { ascending: false }); if (error) return json({ error: error.message }, 500); return json({ records: data || [] }) }
      const body = await request.json(); const driverName = String(body.driverName || '').trim(); const vehicleNumber = String(body.vehicleNumber || '').trim(); const medicalValidDate = String(body.medicalValidDate || '')
      if (!driverName || !vehicleNumber || !medicalValidDate || body.medicalVerified !== true) return json({ error: 'Complete all fields and confirm that the medical document was verified.' }, 400)
      const medicalExpiryDate = expiryFor(medicalValidDate); if (!medicalExpiryDate) return json({ error: 'Enter a valid medical date.' }, 400)
      const record = { id: uuidv4(), driver_name: driverName, vehicle_number: vehicleNumber, medical_valid_date: medicalValidDate, medical_expiry_date: medicalExpiryDate, medical_verified: true, created_by: auth.user.id }
      const { data, error } = await supabaseAdmin.from('driver_records').insert(record).select('*').single(); if (error) return json({ error: error.message }, 500); return json({ record: data }, 201)
    }
    if (route === '/admin/users' && method === 'GET') { if (auth.error) return json({ error: auth.error }, auth.status); if (auth.profile?.role !== 'admin') return json({ error: 'Admin access required.' }, 403); const { data, error } = await supabaseAdmin.from('profiles').select('id, email, full_name, role, approval_status, created_at').order('created_at', { ascending: false }); if (error) return json({ error: error.message }, 500); return json({ users: data || [] }) }
    if (route.startsWith('/admin/users/') && method === 'PATCH') { if (auth.error) return json({ error: auth.error }, auth.status); if (auth.profile?.role !== 'admin') return json({ error: 'Admin access required.' }, 403); const userId = route.split('/').pop(); const body = await request.json(); const approvalStatus = body.approvalStatus === 'approved' ? 'approved' : 'rejected'; const { data, error } = await supabaseAdmin.from('profiles').update({ approval_status: approvalStatus }).eq('id', userId).select('id, email, full_name, role, approval_status').single(); if (error) return json({ error: error.message }, 500); return json({ user: data }) }
    if (route.startsWith('/records/') && method === 'DELETE') {
      if (auth.error) return json({ error: auth.error }, auth.status)
      if (auth.profile?.role !== 'admin') return json({ error: 'Only an admin can delete records.' }, 403)
      const recordId = route.split('/').pop()
      const { error } = await supabaseAdmin.from('driver_records').delete().eq('id', recordId)
      if (error) return json({ error: error.message }, 500)
      return json({ message: 'Record deleted.' })
    }
    return json({ error: `Route ${route} not found` }, 404)
  } catch (error) { console.error('API Error:', error); return json({ error: error.message || 'Internal server error' }, 500) }
}

export const GET = handleRoute
export const POST = handleRoute
export const PATCH = handleRoute
export const DELETE = handleRoute