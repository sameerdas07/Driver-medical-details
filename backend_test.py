import json
import os
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = os.environ.get("NEXT_PUBLIC_BASE_URL", "https://driver-data-hub.preview.emergentagent.com").rstrip("/") + "/api"

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=20) as response:
            raw = response.read().decode()
            try: payload = json.loads(raw)
            except json.JSONDecodeError: payload = raw
            return response.status, payload
    except HTTPError as exc:
        raw = exc.read().decode()
        try: payload = json.loads(raw)
        except json.JSONDecodeError: payload = raw
        return exc.code, payload
    except (URLError, TimeoutError) as exc:
        return None, str(exc)

def expect(label, method, path, status, body=None, token=None):
    actual, payload = call(method, path, body, token)
    ok = actual == status
    print(f"{'PASS' if ok else 'FAIL'} {label}: HTTP {actual}, expected {status}")
    if not ok: print(f"  payload={payload}")
    return ok, payload

def main():
    results = []
    results.append(expect("API root", "GET", "/", 200)[0])
    for path in ("/me", "/records", "/admin/users"):
        results.append(expect(f"protected {path} without token", "GET", path, 401)[0])
    # Malformed signup is safe and confirms validation without creating data.
    results.append(expect("signup rejects short password/missing name", "POST", "/signup", 400, {"email":"invalid@example.com", "password":"short"})[0])
    email = f"backend-check-{uuid.uuid4().hex[:12]}@example.com"
    signup_status, signup = call("POST", "/signup", {"email": email, "password":"DisposablePass!9", "fullName":"Backend Verification"})
    signup_ok = signup_status in (200, 201)
    print(f"{'PASS' if signup_ok else 'INFO'} disposable signup: HTTP {signup_status}")
    if not signup_ok: print(f"  payload={signup}")
    results.append(signup_ok)
    # Sign in via Supabase REST, keeping returned secrets out of output.
    if signup_ok:
        supabase_url = os.environ.get("SUPABASE_URL", "")
        anon = os.environ.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
        if supabase_url and anon:
            req = Request(supabase_url + "/auth/v1/token?grant_type=password", data=json.dumps({"email":email,"password":"DisposablePass!9"}).encode(), headers={"Content-Type":"application/json","apikey":anon}, method="POST")
            try:
                with urlopen(req, timeout=20) as r: auth = json.loads(r.read().decode())
                token = auth.get("access_token")
            except Exception as exc:
                token = None; print(f"INFO sign in unavailable: {type(exc).__name__}")
            if token:
                results.append(expect("signed-in profile", "GET", "/me", 200, token=token)[0])
                results.append(expect("pending user cannot list records", "GET", "/records", 403, token=token)[0])
                results.append(expect("pending user cannot create record", "POST", "/records", 403, {"driverName":"Asha Rao","vehicleNumber":"KA-01-AB-4821","medicalValidDate":"2026-03-15","medicalVerified":True}, token)[0])
            else: print("INFO authenticated flow skipped because sign-in token was unavailable")
    print(f"RESULT {sum(results)}/{len(results)} required checks passed")
    return 0 if all(results) else 1

if __name__ == "__main__": raise SystemExit(main())
