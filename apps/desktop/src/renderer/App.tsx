import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from "@zxing/library";
import type { BrowserMultiFormatReader } from "@zxing/browser";

type Role = "seller" | "admin";
type Page =
  | "dashboard"
  | "products"
  | "services"
  | "sell"
  | "employees"
  | "accounts"
  | "returns"
  | "reports"
  | "admin"
  | "mysales"
  | "inventory"
  | "expenses";
type PaymentMethod = "cash" | "till" | "bank" | "split";
type SortDir = "asc" | "desc";

type Setting = {
  businessName: string;
  logoPath?: string | null;
  poBox?: string | null;
  town?: string | null;
  telNo?: string | null;
  cuSerialNo?: string | null;
  cuInvoiceNo?: string | null;
  kraPin?: string | null;
  returnPolicy?: string | null;
  currency: string;
  taxRate: number;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  backupPath?: string | null;
  googleSheetUrl?: string | null;
  loyaltyPointsRate?: number;
  loyaltyRedeemRate?: number;
  lowStockSoundEnabled?: boolean;
  allowEmployeeExpenses?: boolean;
  taxIncluded?: boolean;
};

type Branch = { id: string; name: string; currency: string; tax_rate: number };
type Device = { id: string; branch_id: string; name: string };
type Seller = { id: string; name: string; role: "admin" | "seller"; active: number };
type Product = {
  id: string;
  name: string;
  category?: string | null;
  base_price: number;
  tax_rate: number;
  stock_qty: number;
  low_stock_alert: number | null;
  barcode?: string | null;
  expiry_date?: number | null;
};
type Service = { id: string; name: string; tax_rate: number; suggested_price?: number; cost_price?: number };

// API dev server defaults to 3333; override with VITE_API_BASE if set.
const API_BASE = (import.meta as any).env.VITE_API_BASE ?? "http://localhost:3333";
const SCAN_CHANNEL = "pos-scan";

// API readiness check - cache the result
let apiReady = false;
let apiReadyCheck: Promise<boolean> | null = null;

const checkApiReady = async (): Promise<boolean> => {
  if (apiReady) return true;
  if (apiReadyCheck) return apiReadyCheck;
  
  apiReadyCheck = (async () => {
    // Wait up to 5 seconds for API to start (20 attempts × 250ms)
    for (let i = 0; i < 20; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${API_BASE}/health`, { 
          signal: controller.signal 
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          apiReady = true;
          return true;
        }
      } catch {
        // Not ready yet, continue waiting
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  })();
  
  return apiReadyCheck;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Check API readiness first for critical paths
  if (!apiReady && (path === "/settings" || path === "/health" || path === "/verify-product-key" || path === "/setup")) {
    await checkApiReady();
  }
  
  // More retries for critical paths to allow API startup time
  const maxAttempts = path === "/setup" || path === "/verify-product-key" ? 20 : 2;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const token = localStorage.getItem("pos-token");
      const controller = new AbortController();
      // Longer timeout for critical paths to allow API startup
      const timeout = path === "/setup" || path === "/verify-product-key" ? 5000 : 5000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Request failed");
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const isNetwork =
        msg.toLowerCase().includes("failed to fetch") ||
        msg.toLowerCase().includes("networkerror") ||
        msg.toLowerCase().includes("load failed") ||
        msg.toLowerCase().includes("aborted") ||
        err?.name === "TypeError" ||
        err?.name === "AbortError";

      if (!isNetwork || attempt === maxAttempts) break;
      // Longer retry delay for critical paths to allow API startup
      const delay = path === "/setup" || path === "/verify-product-key" ? 500 : 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const msg = String(lastErr?.message ?? lastErr ?? "Request failed");
  if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("networkerror") || msg.toLowerCase().includes("aborted")) {
    throw new Error(`Cannot reach local API at ${API_BASE}. Please restart SELLA and try again.`);
  }
  throw lastErr instanceof Error ? lastErr : new Error(msg);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000, // Data stays fresh for 60s (increased)
      gcTime: 600000, // Cache for 10 minutes (increased)
      retry: 1, // Only 1 retry for faster failure
      refetchOnWindowFocus: false, // Don't refetch on focus
      refetchOnMount: false, // Don't refetch on mount if data is fresh
      refetchOnReconnect: false, // Don't refetch on reconnect
    },
  },
});

// Helper: Play a beep sound for low-stock or generic alerts
const playBeep = (frequency = 880, duration = 0.2) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.05);
  } catch {
    // Ignore audio failures
  }
};

// Helper: Scanner success sound (uses bundled MP3, fully offline)
// Place `store-scanner-beep-90395.mp3` in `src/renderer/public/` so it is served as a static asset.
const SCAN_SOUND_SRC = "./store-scanner-beep-90395.mp3";
const playScanSound = () => {
  try {
    const audio = new Audio(SCAN_SOUND_SRC);
    audio.currentTime = 0;
    // Fire and forget; any play() rejection (e.g. autoplay policy) is ignored
    void audio.play().catch(() => {});
  } catch {
    // Fallback to simple beep if Audio fails
    playBeep(880, 0.15);
  }
};

// Global Toast Notification System
type ToastType = "success" | "error" | "warning" | "info";
type Toast = { id: number; message: string; type: ToastType };
const ToastContext = React.createContext<{
  showToast: (message: string, type?: ToastType) => void;
}>({ showToast: () => {} });

const useToast = () => React.useContext(ToastContext);

const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const typeStyles: Record<ToastType, string> = {
    success: "bg-emerald-600 border-emerald-500",
    error: "bg-red-600 border-red-500",
    warning: "bg-amber-600 border-amber-500",
    info: "bg-blue-600 border-blue-500",
  };

  const typeIcons: Record<ToastType, string> = {
    success: "✓",
    error: "✕",
    warning: "⚠",
    info: "ℹ",
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast Container */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl border text-white text-sm font-medium animate-slide-in-right ${typeStyles[toast.type]}`}
            style={{
              animation: "slideInRight 0.3s ease-out",
            }}
          >
            <span className="text-lg">{typeIcons[toast.type]}</span>
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </ToastContext.Provider>
  );
};

// Global showToast function (will be set by provider)
let globalShowToast: (message: string, type?: ToastType) => void = () => {};
const showToast = (message: string, type?: ToastType) => globalShowToast(message, type);

const useTheme = () => {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("pos-theme") as "light" | "dark") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("pos-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "light" ? "dark" : "light")),
    []
  );

  return { theme, toggleTheme };
};

const App = () => {
  const { theme, toggleTheme } = useTheme();
  const [role, setRole] = useState<Role>("seller");
  const isMobileScanner = useMemo(
    () => new URLSearchParams(window.location.search).get("view") === "mobile-scanner",
    []
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ToastInitializer />
        {isMobileScanner ? (
          <MobileScannerScreen theme={theme} onToggleTheme={toggleTheme} />
        ) : (
          <AppContent
            role={role}
            onRoleChange={setRole}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
        )}
      </ToastProvider>
    </QueryClientProvider>
  );
};

// Hook global showToast to context
const ToastInitializer = () => {
  const { showToast: contextShowToast } = useToast();
  useEffect(() => {
    globalShowToast = contextShowToast;
  }, [contextShowToast]);
  return null;
};

const AppContent = ({
  role,
  onRoleChange,
  theme,
  onToggleTheme,
}: {
  role: Role;
  onRoleChange: (r: Role) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) => {
  const [token, setToken] = useState<string>(() => localStorage.getItem("pos-token") || "");
  const [loginForm, setLoginForm] = useState({
    email: "",
    password: "",
    loading: false,
    error: "",
  });
  const [page, setPage] = useState<Page>(role === "seller" ? "sell" : "dashboard");
  const [pageHistory, setPageHistory] = useState<Page[]>([]);
  const navigate = useCallback((next: Page) => {
    setPage((prev) => {
      if (prev !== next) setPageHistory((h) => [...h, prev].slice(-30));
      return next;
    });
  }, []);
  const goBack = useCallback(() => {
    setPageHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setPage(prev);
      return h.slice(0, -1);
    });
  }, []);
  const [offlineQueue, setOfflineQueue] = useState<number>(() => {
    const saved = localStorage.getItem("offline-queue");
    return saved ? Number(saved) || 0 : 0;
  });
  const [lastSync, setLastSync] = useState<string>(() => localStorage.getItem("last-sync") || "Never");
  const [autoSyncEnabled, setAutoSyncEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem("auto-sync-enabled");
    return saved === "true";
  });

  useEffect(() => {
    // If role is seller, prevent navigation to admin-only pages.
    const allowed: Page[] = ["sell", "returns", "products", "services", "mysales", "expenses"];
    if (role === "seller" && !allowed.includes(page)) {
      setPage("sell");
      setPageHistory([]);
    }
  }, [role, page]);

  // Background auto-sync: periodically push to Google Sheets if URL is set
  // Includes exponential backoff for retries
  useEffect(() => {
    if (!autoSyncEnabled || role !== "admin") return;

    const runSync = async () => {
      try {
        // Check if we have a Google Sheet URL configured
        const settingsData = await api<Setting | null>("/settings");
        if (!settingsData?.googleSheetUrl) return;

        // Check if we're online
        if (!navigator.onLine) return;

        // First, check for pending items ready to retry
        const pending = await api<{ id: number; attempt_count: number }[]>("/sync/sheets/pending");
        if (pending && pending.length > 0) {
          // Retry pending items
          for (const item of pending) {
            try {
              await api(`/sync/sheets/retry/${item.id}`, { method: "POST", body: JSON.stringify({}) });
            } catch {
              // Schedule for retry with backoff
              await api(`/sync/sheets/schedule-retry/${item.id}`, { method: "POST", body: JSON.stringify({}) });
            }
          }
        }

        // Trigger a new push
        await api("/sync/sheets/push", { method: "POST", body: JSON.stringify({}) });
        setLastSync(new Date().toLocaleString());
        localStorage.setItem("last-sync", new Date().toLocaleString());
      } catch {
        // Silently fail; will retry next interval
      }
    };

    // Run immediately on mount, then every 5 minutes
    runSync();
    const interval = setInterval(runSync, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [autoSyncEnabled, role]);

  // Priority 1: Settings (needed immediately for setup check)
  const { data: settings, refetch: refetchSettings, isFetching: loadingSettings } =
    useQuery<Setting | null>({
      queryKey: ["settings"],
      queryFn: () => api("/settings"),
      staleTime: 60000, // Cache for 1 minute
    });
  
  // Priority 2: Sellers (needed for login, but can wait a bit)
  const { data: sellers = [] } = useQuery<Seller[]>({
    queryKey: ["sellers"],
    queryFn: () => api("/sellers"),
    staleTime: 60000,
    // Delay slightly to let settings load first
    enabled: !loadingSettings,
  });
  
  // Priority 3: Other data (only load when authenticated and settings loaded)
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["branches"],
    queryFn: () => api("/branches"),
    enabled: !!token && !!settings,
    staleTime: 60000,
  });
  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["devices"],
    queryFn: () => api("/devices"),
    enabled: !!token && !!settings,
    staleTime: 60000,
  });
  
  // Priority 4: Products & Services (lazy load - only when needed)
  const productsQuery = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api("/products"),
    enabled: !!token && !!settings && (page === "sell" || page === "products" || page === "inventory"),
    staleTime: 30000, // Cache for 30s
  });
  const servicesQuery = useQuery<Service[]>({
    queryKey: ["services"],
    queryFn: () => api("/services"),
    enabled: !!token && !!settings && (page === "sell" || page === "services"),
    staleTime: 30000,
  });
  
  // Priority 5: KPI (only load when viewing dashboard/reports)
  const kpiQuery = useQuery<any[]>({
    queryKey: ["reports", "kpi"],
    queryFn: () => api("/reports/kpi"),
    enabled: !!token && !!settings && (page === "dashboard" || page === "reports"),
    staleTime: 60000,
  });

  const [branchId, setBranchId] = useState<string>(() => localStorage.getItem("branchId") || "");
  const [deviceId, setDeviceId] = useState<string>(() => localStorage.getItem("deviceId") || "");
  const [sellerId, setSellerId] = useState<string>(
    () => localStorage.getItem("sellerId") || ""
  );
  const [scanValue, setScanValue] = useState<string | null>(null);

  useEffect(() => {
    // Validate stored token and hydrate role/sellerId from server.
    if (!token) return;
    api<{ sellerId: string; name: string; role: Role }>("/auth/me")
      .then((me) => {
        if (me?.sellerId) {
          localStorage.setItem("sellerId", me.sellerId);
          setSellerId(me.sellerId);
        }
        if (me?.role) onRoleChange(me.role);
      })
      .catch(() => {
        localStorage.removeItem("pos-token");
        setToken("");
        setLoginGate((p) => ({ ...p, open: true, sellerId: "", pin: "", error: "" }));
      });
  }, [token]);

  useEffect(() => {
    // Ensure branchId is valid (exists in loaded branches)
    if (branches.length > 0) {
      const validBranch = branches.find(b => b.id === branchId);
      if (!validBranch) {
        setBranchId(branches[0].id);
      }
    }
    // Ensure deviceId is valid
    if (devices.length > 0) {
      const validDevice = devices.find(d => d.id === deviceId);
      if (!validDevice) {
        setDeviceId(devices[0].id);
      }
    }
    // Ensure sellerId is valid
    if (sellers.length > 0) {
      const validSeller = sellers.find(s => s.id === sellerId);
      if (!validSeller) {
        setSellerId(sellers[0].id);
      }
    }
  }, [branchId, deviceId, sellerId, branches, devices, sellers]);

  useEffect(() => {
    if (branchId) localStorage.setItem("branchId", branchId);
    if (deviceId) localStorage.setItem("deviceId", deviceId);
    if (sellerId) localStorage.setItem("sellerId", sellerId);
  }, [branchId, deviceId, sellerId]);

  const currentSeller = useMemo(
    () => sellers.find((s) => s.id === sellerId) ?? sellers[0],
    [sellers, sellerId]
  );

  // Employee login gate (4-digit PIN) - required for attribution and KPI
  const [loginGate, setLoginGate] = useState<{
    open: boolean;
    sellerId: string;
    pin: string;
    error: string;
    busy: boolean;
  }>(() => ({
    open: !localStorage.getItem("pos-token"),
    sellerId: localStorage.getItem("sellerId") || "",
    pin: "",
    error: "",
    busy: false,
  }));

  useEffect(() => {
    // Only enforce login once configured (after setup)
    if (!settings) return;
    const valid = sellerId && sellers.some((s) => s.id === sellerId && s.active);
    if (!valid) {
      setLoginGate((p) => ({ ...p, open: true, sellerId: "", pin: "", error: "" }));
    }
  }, [settings, sellers, sellerId]);

  useEffect(() => {
    // Professional first-run: if ONLY one active account exists (usually Admin), preselect it.
    if (!loginGate.open) return;
    if (loginGate.sellerId) return;
    const active = (sellers ?? []).filter((s) => s.active);
    if (active.length === 1) {
      setLoginGate((p) => ({ ...p, sellerId: active[0].id }));
    }
  }, [loginGate.open, loginGate.sellerId, sellers]);

  const doLogin = async () => {
    setLoginGate((p) => ({ ...p, busy: true, error: "" }));
    try {
      const active = (sellers ?? []).filter((s) => s.active);
      const targetId = loginGate.sellerId || active[0]?.id || "";
      const sel = sellers.find((s) => s.id === targetId);
      if (!sel) throw new Error("Select employee");
      if (!loginGate.sellerId) {
        setLoginGate((p) => ({ ...p, sellerId: targetId }));
      }
      const pin = loginGate.pin.trim();
      if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be 4 digits");
      const res = await api<{ token: string; role: Role; sellerId: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ name: sel.name, pin }),
      });
      localStorage.setItem("pos-token", res.token);
      setToken(res.token);
      localStorage.setItem("sellerId", res.sellerId);
      setSellerId(res.sellerId);
      onRoleChange(res.role);
      setLoginGate((p) => ({ ...p, open: false, pin: "", error: "", busy: false }));
    } catch (e: any) {
      setLoginGate((p) => ({ ...p, busy: false, error: e?.message ?? "Login failed" }));
    }
  };

  // Check if product key is verified - MUST be before any conditional returns
  const [productKeyVerified, setProductKeyVerified] = useState(() => {
    return localStorage.getItem("sella-product-key-verified") === "true";
  });

  if (loadingSettings) {
    return (
      <div className="p-6 text-sm text-[var(--muted)]">
        Loading environment and settings...
      </div>
    );
  }

  if (!settings) {
    // Show product key verification first if not verified
    if (!productKeyVerified) {
      return (
        <ProductKeyVerification
          onVerified={() => {
            setProductKeyVerified(true);
            // Small delay to ensure state updates
            setTimeout(() => {
              refetchSettings();
            }, 100);
          }}
        />
      );
    }

    // Show setup wizard after product key is verified
    return (
      <div className="space-y-6 p-4 sm:p-8">
        <PageHeading
          id="setup"
          title="First-time Setup"
          subtitle="Configure business, pricing, KPI, and admin. This cannot be skipped."
        />
        <SetupWizard
          onComplete={() => {
            // After setup: land in admin mode, and use the created admin as the logged-in employee.
            const sid =
              localStorage.getItem("sellerId") || localStorage.getItem("adminId") || "";
            if (sid) setSellerId(sid);
            onRoleChange("admin");
            setPage("admin");
            refetchSettings();
          }}
        />
      </div>
    );
  }

  const handleLogin = async () => {
    setLoginForm((p) => ({ ...p, loading: true, error: "" }));
    try {
      await api<{ token: string; role: Role; sellerId: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ name: loginForm.email, pin: loginForm.password }),
      });
    } catch (err: any) {
      setLoginForm((p) => ({
        ...p,
        error: err?.message ?? "Login failed",
      }));
    } finally {
      setLoginForm((p) => ({ ...p, loading: false }));
    }
  };

  if (loginGate.open) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" data-theme={theme}>
        <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10">
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Employee Login</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--fg)]">Enter 4‑digit PIN</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Required so sales/stock changes are attributed to the right employee for KPI.
            </p>
            <div className="mt-4 grid gap-3">
              <SelectField
                label="Employee"
                value={loginGate.sellerId}
                onChange={(v) => setLoginGate((p) => ({ ...p, sellerId: v }))}
                options={(sellers ?? [])
                  .filter((s) => s.active)
                  .map((s) => ({ value: s.id, label: `${s.name} (${s.role})` }))}
              />
              <TextField
                label="PIN (4 digits)"
                type="password"
                value={loginGate.pin}
                onChange={(v) => setLoginGate((p) => ({ ...p, pin: v }))}
              />
              {loginGate.error && <p className="text-sm text-red-400">{loginGate.error}</p>}
              <button
                className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                onClick={doLogin}
                disabled={loginGate.busy}
              >
                {loginGate.busy ? "Logging in..." : "Login"}
              </button>
              <button
                className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--fg)]"
                onClick={() => window.location.reload()}
                type="button"
              >
                Refresh
              </button>
            </div>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Admin can add employees and set PINs in <span className="font-semibold">Admin → Employees</span>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Shell
      theme={theme}
      onToggleTheme={onToggleTheme}
      role={role}
      businessName={settings.businessName}
      branchId={branchId}
      branches={branches}
      onBranchChange={setBranchId}
      sellerName={currentSeller?.name ?? "Seller"}
      deviceId={deviceId}
      page={page}
      onPageChange={navigate}
      canGoBack={pageHistory.length > 0}
      onBack={goBack}
      offlineQueue={offlineQueue}
    >
      <ErrorBoundary>
        <div className="space-y-6 p-4 sm:p-8">
        {page === "dashboard" && (
          <AdminDashboardPage
            settings={settings}
            branches={branches}
            devices={devices}
            sellers={sellers}
            products={productsQuery.data ?? []}
            services={servicesQuery.data ?? []}
            kpi={kpiQuery.data ?? []}
          />
        )}
        {page === "products" && (
          <ProductsPage
            currency={settings.currency}
            products={productsQuery.data ?? []}
            scannedCode={scanValue}
            onScanConsumed={() => setScanValue(null)}
            canEdit={role === "admin"}
            lowStockSoundEnabled={settings.lowStockSoundEnabled !== false}
          />
        )}
        {page === "services" && (
          <ServicesPage
            currency={settings.currency}
            services={servicesQuery.data ?? []}
            canEdit={role === "admin"}
          />
        )}
        {page === "mysales" && role === "seller" && (
          <MySalesPage currency={settings.currency} />
        )}
        {page === "inventory" && role === "admin" && (
          <AdminInventoryPage
            currency={settings.currency}
            products={productsQuery.data ?? []}
            scannedCode={scanValue}
            onScanConsumed={() => setScanValue(null)}
          />
        )}
        {page === "sell" && (
          <SellPage
            settings={settings}
            branches={branches}
            devices={devices}
            sellers={sellers}
            products={productsQuery.data ?? []}
            services={servicesQuery.data ?? []}
            branchId={branchId}
            deviceId={deviceId}
            sellerId={sellerId}
            onBranchChange={setBranchId}
            onDeviceChange={setDeviceId}
            onSellerChange={setSellerId}
            scanValue={scanValue}
            onScan={setScanValue}
            onScanConsumed={() => setScanValue(null)}
            onGoProducts={() => navigate("products")}
          />
        )}
        {page === "employees" && (
          <EmployeesPage sellers={sellers} kpi={kpiQuery.data ?? []} />
        )}
        {page === "accounts" && (
          <AccountsPage
            currency={settings.currency}
            branchId={branchId}
            branches={branches}
          />
        )}
        {page === "expenses" && (
          <ExpensesPage
            currency={settings.currency}
            branchId={branchId}
            branches={branches}
            isAdmin={role === "admin"}
            allowEmployeeExpenses={settings.allowEmployeeExpenses ?? false}
          />
        )}
        {page === "returns" && (
          role === "seller" ? (
            <ReturnsPage
              currency={settings.currency}
              branchId={branchId}
              branches={branches}
              sellerId={sellerId}
              sellers={sellers}
            />
          ) : (
            <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 text-sm text-[var(--fg)] shadow-sm">
              <p className="font-semibold">Returns are handled on the Seller side.</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Switch to <span className="font-semibold">Seller</span> to record returned goods.
              </p>
              <button
                className="mt-4 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--fg)]"
                onClick={() => navigate("sell")}
                type="button"
              >
                Go to Sell
              </button>
            </div>
          )
        )}
        {page === "reports" && (
          <ReportsPage
            currency={settings.currency}
            kpi={kpiQuery.data ?? []}
            branches={branches}
            products={productsQuery.data ?? []}
            services={servicesQuery.data ?? []}
          />
        )}
        {page === "admin" && (
          <AdminPage
            settings={settings}
            branches={branches}
            devices={devices}
            sellers={sellers}
            kpi={kpiQuery.data ?? []}
            offlineQueue={offlineQueue}
            lastSync={lastSync}
            onSyncNow={() => {
              setOfflineQueue(0);
              const ts = new Date().toLocaleString();
              setLastSync(ts);
              localStorage.setItem("offline-queue", "0");
              localStorage.setItem("last-sync", ts);
            }}
          />
        )}
        </div>
      </ErrorBoundary>
    </Shell>
  );
};

// Product Key Verification Component
const ProductKeyVerification = ({ onVerified }: { onVerified: () => void }) => {
  const [productKey, setProductKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [apiStatus, setApiStatus] = useState<"checking" | "ready" | "failed">("checking");

  // Check API readiness on mount
  useEffect(() => {
    const checkApi = async () => {
      try {
        // Wait for API to be ready (up to 5 seconds)
        const ready = await checkApiReady();
        if (ready) {
          setApiStatus("ready");
        } else {
          setApiStatus("failed");
          setError("API is not responding. Please restart SELLA.");
          setShowContact(true);
        }
      } catch {
        setApiStatus("failed");
        setError("API connection failed. Please restart SELLA.");
        setShowContact(true);
      }
    };
    checkApi();
  }, []);

  const handleVerify = async () => {
    if (!productKey.trim()) {
      setError("Please enter your product key");
      return;
    }

    setLoading(true);
    setError("");
    setShowContact(false);

    try {
      // Ensure API is ready before verification
      if (!apiReady) {
        setApiStatus("checking");
        const ready = await checkApiReady();
        if (!ready) {
          setApiStatus("failed");
          setShowContact(true);
          throw new Error("API connection failed. Please restart SELLA and try again.");
        }
        setApiStatus("ready");
      }

      const result = await api<{ verified: boolean; message: string }>("/verify-product-key", {
        method: "POST",
        body: JSON.stringify({ productKey: productKey.trim() }),
      });

      if (result.verified) {
        localStorage.setItem("sella-product-key-verified", "true");
        onVerified();
      } else {
        setError("Invalid product key");
        setShowContact(true);
      }
    } catch (err: any) {
      const msg = err?.message || "Verification failed";
      setError(msg);
      if (msg.includes("Cannot reach local API") || msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("not responding")) {
        setApiStatus("failed");
        setShowContact(true);
        setError("API connection failed. Please restart SELLA and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const services = [
    "Complete POS System with Barcode Scanner",
    "Inventory Management & Stock Tracking",
    "Sales Reports & Analytics",
    "Employee Management & KPI Tracking",
    "Multi-Branch Support",
    "Offline-First Architecture (No Internet Required)",
    "Receipt Printing & PDF Export",
    "Google Sheets Integration",
    "Customer Loyalty Points System",
    "Expense Tracking & Net Profit Calculation",
    "Audit Logs & Compliance",
    "Product & Service Management",
    "Returns & Refunds Management",
    "Dark Mode & Modern UI",
    "24/7 Support & Updates",
  ];

  // Background image path - use public folder path
  const bgImagePath = "./POSbg.jpg";

  return (
    <div 
      className="fixed inset-0 flex items-center justify-center p-4 overflow-auto"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        backgroundColor: '#000000',
      }}
    >
      {/* Background with POS Terminal Image */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url('${bgImagePath}')`,
          opacity: 0.3,
        }}
      />
      
      {/* Gradient Overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-red-900/40 via-blue-900/40 to-black/80" />
      
      {/* Content */}
      <div className="relative z-10 w-full max-w-4xl">
        <div className="bg-black/80 backdrop-blur-xl rounded-2xl border border-red-500/30 shadow-2xl p-8 md:p-12">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-3 bg-gradient-to-r from-red-400 to-blue-400 bg-clip-text text-transparent">
              Welcome to SELLA POS
            </h1>
            <p className="text-gray-300 text-lg">
              Professional Point of Sale System
            </p>
          </div>

          {/* API Status Indicator */}
          {apiStatus === "checking" && (
            <div className="mb-4 p-3 rounded-lg bg-blue-900/30 border border-blue-500/30">
              <div className="flex items-center gap-2 text-blue-300 text-sm">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Waiting for API to start...</span>
              </div>
            </div>
          )}

          {/* Product Key Input */}
          <div className="mb-8">
            <label className="block text-white text-sm font-medium mb-3">
              Enter Your Product Key
            </label>
            <div className="flex gap-3">
              <input
                type="password"
                value={productKey}
                onChange={(e) => {
                  setProductKey(e.target.value);
                  setError("");
                  setShowContact(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) {
                    handleVerify();
                  }
                }}
                placeholder={apiStatus === "checking" ? "Waiting for API..." : "Enter your product key..."}
                className="flex-1 px-4 py-3 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                disabled={loading}
              />
              <button
                onClick={handleVerify}
                disabled={loading}
                className="px-8 py-3 bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-700 hover:to-blue-700 text-white font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
              >
                {loading ? "Verifying..." : apiStatus === "checking" ? "Waiting..." : apiStatus === "failed" ? "Retry" : "Verify"}
              </button>
            </div>
            {error && (
              <p className="mt-2 text-red-400 text-sm">{error}</p>
            )}
            {apiStatus === "ready" && !error && !loading && (
              <p className="mt-2 text-green-400 text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                API connected and ready
              </p>
            )}
          </div>

          {/* Services List */}
          <div className="mb-8">
            <h2 className="text-white text-xl font-semibold mb-4 text-center">
              What You Get with SELLA POS
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-2">
              {services.map((service, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 p-3 rounded-lg bg-gray-900/30 border border-gray-700/50 hover:border-red-500/50 transition-colors"
                >
                  <svg className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-gray-300 text-sm">{service}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Contact Information */}
          {showContact && (
            <div className="mt-6 p-6 rounded-lg bg-gradient-to-r from-red-900/30 to-blue-900/30 border border-red-500/30">
              <h3 className="text-white font-semibold mb-3 text-center">
                Need a Product Key?
              </h3>
              <p className="text-gray-300 text-center mb-4">
                Thank you for showing interest in SELLA POS. To get your product key and unlock all features, please contact us:
              </p>
              <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
                <a
                  href="mailto:mokamigeoffrey@gmail.com"
                  className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-center"
                >
                  📧 mokamigeoffrey@gmail.com
                </a>
                <a
                  href="mailto:kefamwita94@gmail.com"
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-center"
                >
                  📧 kefamwita94@gmail.com
                </a>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 text-center text-gray-400 text-sm">
            <p>© 2024 SELLA POS. All rights reserved.</p>
            <p className="mt-1">Built with ❤️ for modern businesses</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const SetupWizard = ({ onComplete }: { onComplete: () => void }) => {
  const [form, setForm] = useState({
    businessName: "",
    logoPath: "",
    poBox: "",
    town: "",
    telNo: "",
    cuSerialNo: "",
    cuInvoiceNo: "",
    kraPin: "",
    returnPolicy: "",
    branchName: "",
    currency: "KES",
    taxRate: 0,
    deviceName: "Device-1",
    adminName: "",
    adminPin: "",
    receiptHeader: "",
    receiptFooter: "",
    backupPath: "",
    pointPerExtraValue: 0.1,
    pointsPerService: 0,
    bonusThreshold: "",
    bonusPoints: "",
    loyaltyPointsRate: 0.01,
    loyaltyRedeemRate: 1,
    taxIncluded: false,
  });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        settings: {
          businessName: form.businessName,
          logoPath: form.logoPath || undefined,
          poBox: form.poBox || undefined,
          town: form.town || undefined,
          telNo: form.telNo || undefined,
          cuSerialNo: form.cuSerialNo || undefined,
          cuInvoiceNo: form.cuInvoiceNo || undefined,
          kraPin: form.kraPin || undefined,
          returnPolicy: form.returnPolicy || undefined,
          currency: form.currency,
          taxRate: Number(form.taxRate),
          receiptHeader: form.receiptHeader || undefined,
          receiptFooter: form.receiptFooter || undefined,
          backupPath: form.backupPath || undefined,
          loyaltyPointsRate: Number(form.loyaltyPointsRate) || 0.01,
          loyaltyRedeemRate: Number(form.loyaltyRedeemRate) || 1,
          taxIncluded: form.taxIncluded || false,
        },
        branch: {
          name: form.branchName,
          currency: form.currency,
          taxRate: Number(form.taxRate),
        },
        deviceName: form.deviceName,
        admin: {
          name: form.adminName,
          pin: form.adminPin,
        },
        kpi: {
          pointPerExtraValue: Number(form.pointPerExtraValue),
          pointsPerService: Number(form.pointsPerService),
          bonusThreshold: form.bonusThreshold ? Number(form.bonusThreshold) : null,
          bonusPoints: form.bonusPoints ? Number(form.bonusPoints) : null,
        },
      };
      const result = await api<{ branchId: string; deviceId: string; adminId: string }>(
        "/setup",
        { method: "POST", body: JSON.stringify(payload) }
      );
      localStorage.setItem("branchId", result.branchId);
      localStorage.setItem("deviceId", result.deviceId);
      localStorage.setItem("adminId", result.adminId);
      // Professional flow: setup creates Admin first; use Admin as the initial logged-in employee.
      localStorage.setItem("sellerId", result.adminId);
      localStorage.setItem("pos-role", "admin");
    },
    onSuccess: onComplete,
    onError: (err: any) => setError(err?.message ?? "Setup failed"),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4 rounded-2xl card p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">First-time Setup</h1>
          <p className="text-sm text-[var(--muted)]">
        Configure business, pricing, KPI, and admin. This cannot be skipped.
      </p>
        </div>
        <span className="accent-chip rounded-full px-3 py-1 text-xs font-semibold">
          Guided
        </span>
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <TextField
          label="Business name"
          value={form.businessName}
          onChange={(v) => setForm((p) => ({ ...p, businessName: v }))}
        />
        <TextField
          label="Logo path (optional)"
          value={form.logoPath}
          onChange={(v) => setForm((p) => ({ ...p, logoPath: v }))}
        />
        <TextField
          label="PO BOX (for receipt)"
          value={form.poBox}
          onChange={(v) => setForm((p) => ({ ...p, poBox: v }))}
        />
        <TextField
          label="Town (for receipt)"
          value={form.town}
          onChange={(v) => setForm((p) => ({ ...p, town: v }))}
        />
        <TextField
          label="TEL NO (for receipt)"
          value={form.telNo}
          onChange={(v) => setForm((p) => ({ ...p, telNo: v }))}
        />
        <TextField
          label="CU Serial No (optional)"
          value={form.cuSerialNo}
          onChange={(v) => setForm((p) => ({ ...p, cuSerialNo: v }))}
        />
        <TextField
          label="CU Invoice No (optional)"
          value={form.cuInvoiceNo}
          onChange={(v) => setForm((p) => ({ ...p, cuInvoiceNo: v }))}
        />
        <TextField
          label="KRA PIN (for receipts)"
          value={form.kraPin}
          onChange={(v) => setForm((p) => ({ ...p, kraPin: v }))}
        />
        <TextField
          label="Return Policy (for receipts)"
          value={form.returnPolicy}
          onChange={(v) => setForm((p) => ({ ...p, returnPolicy: v }))}
        />
        <TextField
          label="Branch name"
          value={form.branchName}
          onChange={(v) => setForm((p) => ({ ...p, branchName: v }))}
        />
        <TextField
          label="Currency"
          value={form.currency}
          onChange={(v) => setForm((p) => ({ ...p, currency: v }))}
        />
        <NumberField
          label="Tax/VAT rate"
          value={form.taxRate}
          onChange={(v) => setForm((p) => ({ ...p, taxRate: v }))}
        />
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="taxIncluded"
            checked={form.taxIncluded}
            onChange={(e) => setForm((p) => ({ ...p, taxIncluded: e.target.checked }))}
            className="h-4 w-4 rounded border-[var(--stroke)] text-teal-600 focus:ring-teal-500"
          />
          <label htmlFor="taxIncluded" className="text-sm text-[var(--fg)]">
            Include tax in sale totals (if unchecked, tax is tracked but not added to totals)
          </label>
        </div>
        <TextField
          label="Device name"
          value={form.deviceName}
          onChange={(v) => setForm((p) => ({ ...p, deviceName: v }))}
        />
        <TextField
          label="Admin name"
          value={form.adminName}
          onChange={(v) => setForm((p) => ({ ...p, adminName: v }))}
        />
        <TextField
          label="Admin PIN"
          type="password"
          value={form.adminPin}
          onChange={(v) => setForm((p) => ({ ...p, adminPin: v }))}
        />
        <NumberField
          label="KPI: points per extra value unit"
          value={form.pointPerExtraValue}
          onChange={(v) => setForm((p) => ({ ...p, pointPerExtraValue: v }))}
        />
        <NumberField
          label="KPI: points per service"
          value={form.pointsPerService}
          onChange={(v) => setForm((p) => ({ ...p, pointsPerService: v }))}
        />
        <TextField
          label="KPI bonus threshold (optional)"
          value={form.bonusThreshold}
          onChange={(v) => setForm((p) => ({ ...p, bonusThreshold: v }))}
        />
        <TextField
          label="KPI bonus points (optional)"
          value={form.bonusPoints}
          onChange={(v) => setForm((p) => ({ ...p, bonusPoints: v }))}
        />
        <NumberField
          label="Loyalty: points per KES spent (e.g. 0.01 = 1pt/100)"
          value={form.loyaltyPointsRate}
          onChange={(v) => setForm((p) => ({ ...p, loyaltyPointsRate: v }))}
        />
        <NumberField
          label="Loyalty: KES value per point redeemed"
          value={form.loyaltyRedeemRate}
          onChange={(v) => setForm((p) => ({ ...p, loyaltyRedeemRate: v }))}
        />
        <TextField
          label="Receipt header"
          value={form.receiptHeader}
          onChange={(v) => setForm((p) => ({ ...p, receiptHeader: v }))}
        />
        <TextField
          label="Receipt footer"
          value={form.receiptFooter}
          onChange={(v) => setForm((p) => ({ ...p, receiptFooter: v }))}
        />
        <TextField
          label="Backup path"
          value={form.backupPath}
          onChange={(v) => setForm((p) => ({ ...p, backupPath: v }))}
        />
      </div>
      <button
        className="mt-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
        onClick={() => mutation.mutate()}
        disabled={mutation.isLoading}
      >
        {mutation.isLoading ? "Saving..." : "Save and continue"}
      </button>
    </div>
  );
};

const Dashboard = ({ settings }: { settings: Setting }) => {
  const qc = useQueryClient();
  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["branches"],
    queryFn: () => api("/branches"),
  });
  const { data: devices } = useQuery<Device[]>({
    queryKey: ["devices"],
    queryFn: () => api("/devices"),
  });
  const { data: sellers } = useQuery<Seller[]>({
    queryKey: ["sellers"],
    queryFn: () => api("/sellers"),
  });
  const { data: products } = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api("/products"),
  });
  const { data: services } = useQuery<Service[]>({
    queryKey: ["services"],
    queryFn: () => api("/services"),
  });
  const { data: kpi } = useQuery<any[]>({
    queryKey: ["reports", "kpi"],
    queryFn: () => api("/reports/kpi"),
  });

  const [scanValue, setScanValue] = useState<string | null>(null);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4">
      <section
        id="overview"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
          <Card title="Branches" value={`${branches?.length ?? 0}`} note="Registered" />
          <Card title="Products" value={`${products?.length ?? 0}`} note="Tracked" />
          <Card title="Services" value={`${services?.length ?? 0}`} note="Dynamic pricing" />
        </section>

      <section id="inventory" className="grid gap-4 lg:grid-cols-[1.35fr,1fr]">
          <ProductManager
            currency={settings.currency}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ["products"] });
            }}
          scannedCode={scanValue}
        />
        <ScannerPanel
          onScan={(code) => setScanValue(code)}
          mobileLink={`${window.location.origin}/?view=mobile-scanner`}
        />
      </section>

      <section id="services" className="grid gap-4 lg:grid-cols-2">
          <ServiceManager
            currency={settings.currency}
            onSaved={() => qc.invalidateQueries({ queryKey: ["services"] })}
          />
        <KpiBoard currency={settings.currency} data={kpi ?? []} />
        </section>

      <section id="sales" className="grid gap-4 lg:grid-cols-2">
          <SalesComposer
            currency={settings.currency}
            branches={branches ?? []}
            devices={devices ?? []}
            sellers={sellers ?? []}
            products={products ?? []}
            services={services ?? []}
            onSale={() => {
              qc.invalidateQueries({ queryKey: ["reports", "kpi"] });
            }}
          />
        <div className="rounded-lg border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Status</h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Offline ready. API: {API_BASE}.
          </p>
          <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-teal-400">
            <span className="h-2 w-2 rounded-full bg-teal-400" />
            Synced
          </div>
        </div>
        </section>
      </main>
  );
};

const ProductManager = ({
  currency,
  onSaved,
  scannedCode,
  onScanConsumed,
}: {
  currency: string;
  onSaved: () => void;
  scannedCode?: string | null;
  onScanConsumed: () => void;
}) => {
  const qc = useQueryClient();
  const { data: products } = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api("/products"),
  });
  const [form, setForm] = useState({
    name: "",
    category: "",
    barcode: "",
    costPrice: 0,
    basePrice: 0,
    stockQty: 0,
    taxRate: 0,
    expiryDate: "",
  });
  const [productTab, setProductTab] = useState<"all" | "add" | "low" | "import">("all");
  const [search, setSearch] = useState("");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [existingProduct, setExistingProduct] = useState<Product | null>(null);
  const [addQuantityMode, setAddQuantityMode] = useState(false);
  const [quantityToAdd, setQuantityToAdd] = useState(0);
  
  useEffect(() => {
    if (scannedCode) {
      setForm((p) => ({ ...p, barcode: scannedCode }));
      setProductTab("add");
      onScanConsumed();
    }
  }, [scannedCode]);

  // Detect if barcode exists when entered
  useEffect(() => {
    if (!form.barcode.trim()) {
      setExistingProduct(null);
      setAddQuantityMode(false);
      setQuantityToAdd(0);
      return;
    }

    const trimmedBarcode = form.barcode.trim().toLowerCase();
    const found = products?.find(
      (p) => (p.barcode ?? "").toLowerCase() === trimmedBarcode
    );

    if (found) {
      // Barcode exists - switch to add quantity mode
      setExistingProduct(found);
      setAddQuantityMode(true);
      setForm((p) => ({
        ...p,
        category: found.category || p.category,
        name: found.name,
        costPrice: found.cost_price || p.costPrice,
        basePrice: found.base_price || p.basePrice,
        taxRate: found.tax_rate || p.taxRate,
      }));
    } else {
      // Barcode doesn't exist - proceed with new product
      setExistingProduct(null);
      setAddQuantityMode(false);
      setQuantityToAdd(0);
    }
  }, [form.barcode, products]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (addQuantityMode && existingProduct) {
        // Add quantity to existing product
        const newStockQty = (existingProduct.stock_qty || 0) + Number(quantityToAdd);
        await api(`/products/${existingProduct.id}`, {
          method: "PUT",
          body: JSON.stringify({
            stockQty: newStockQty,
          }),
        });
      } else {
        // Create new product
        const exists =
          products?.some(
            (p) => (p.barcode ?? "").toLowerCase() === (form.barcode || "").toLowerCase()
          ) ?? false;
        if (form.barcode && exists) {
          throw new Error("Duplicate barcode detected.");
        }
        await api("/products", {
          method: "POST",
          body: JSON.stringify({
            barcode: form.barcode || undefined,
            name: form.name,
            category: form.category || undefined,
            costPrice: Number(form.costPrice),
            basePrice: Number(form.basePrice),
            stockQty: Number(form.stockQty),
            taxRate: Number(form.taxRate),
            expiryDate: form.expiryDate ? new Date(`${form.expiryDate}T00:00:00`).getTime() : null,
          }),
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      onSaved();
      setForm({
        barcode: "",
        name: "",
        category: "",
        costPrice: 0,
        basePrice: 0,
        stockQty: 0,
        taxRate: 0,
        expiryDate: "",
      });
      setExistingProduct(null);
      setAddQuantityMode(false);
      setQuantityToAdd(0);
    },
  });

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return products ?? [];
    return (products ?? []).filter((p) => {
  return (
        p.name.toLowerCase().includes(term) ||
        (p.barcode ?? "").toLowerCase().includes(term)
      );
    });
  }, [products, search]);

  const scanMatch = useMemo(() => {
    if (!scannedCode) return null;
    return (products ?? []).find(
      (p) => (p.barcode ?? "").toLowerCase() === scannedCode.toLowerCase()
    );
  }, [products, scannedCode]);

  const handleImportCsv = async (file: File) => {
    setImportStatus("Reading file...");
    const text = await file.text();
    const rows = text
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((line) => line.split(",").map((c) => c.trim()));
    if (rows.length === 0) {
      setImportStatus("No rows found.");
      return;
    }
    // Assume header if includes "name"
    const hasHeader = rows[0].some((c) => c.toLowerCase().includes("name"));
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const items = dataRows
      .map((cols) => ({
        barcode: cols[0] || "",
        name: cols[1] || "",
        basePrice: Number(cols[2] || 0),
        costPrice: Number(cols[3] || 0),
        stockQty: Number(cols[4] || 0),
        taxRate: Number(cols[5] || 0),
      }))
      .filter((r) => r.name && r.barcode);

    if (items.length === 0) {
      setImportStatus("No valid rows. Ensure columns: barcode,name,basePrice,costPrice,stockQty,taxRate");
      return;
    }

    setImportStatus(`Importing ${items.length} items...`);
    try {
      await api("/products/import-bulk", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      setImportStatus(`Imported ${items.length} products.`);
      setSearch("");
      qc.invalidateQueries({ queryKey: ["products"] });
    } catch (err) {
      // fallback to per-row
      let ok = 0;
      for (const item of items) {
        try {
          await api("/products", {
            method: "POST",
            body: JSON.stringify({
              barcode: item.barcode,
              name: item.name,
              basePrice: item.basePrice,
              costPrice: item.costPrice,
              stockQty: item.stockQty,
              taxRate: item.taxRate,
            }),
          });
          ok += 1;
        } catch {
          // ignore individual failures
        }
      }
      setImportStatus(`Imported ${ok}/${items.length} products (fallback per-row).`);
      qc.invalidateQueries({ queryKey: ["products"] });
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Products</p>
          <h2 className="text-lg font-semibold text-[var(--fg)]">Fixed price (base floor)</h2>
        </div>
        {scannedCode ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              scanMatch ? "accent-chip" : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}
          >
            {scanMatch ? "Matched product" : "Not found"} · {scannedCode}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex gap-2 text-sm">
        {(["all", "add", "import", "low"] as const).map((tab) => (
          <button
            key={tab}
            className={`rounded-md px-3 py-1 font-semibold ${
              productTab === tab
                ? "bg-teal-600 text-white"
                : "bg-[var(--surface)] text-[var(--fg)] border border-[var(--stroke)]"
            }`}
            onClick={() => setProductTab(tab)}
          >
            {tab === "all" && "All Products"}
            {tab === "add" && "Add Product"}
            {tab === "import" && "Import"}
            {tab === "low" && "Low Stock"}
          </button>
        ))}
      </div>

      {productTab === "add" && (
        <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <TextField
                    label="Barcode / SKU (required)"
                    value={form.barcode}
                    onChange={(v) => setForm((p) => ({ ...p, barcode: v }))}
                  />
                </div>
                <button
                  className="mb-[2px] h-10 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 text-sm font-semibold text-[var(--fg)]"
                  onClick={() => {
                    setScanOpen(true);
                  }}
                  type="button"
                  title="Scan barcode using camera"
                >
                  Camera scan
                </button>
              </div>
              {scanOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                  <div className="w-full max-w-lg rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Barcode</p>
                        <p className="text-lg font-semibold text-[var(--fg)]">Camera scan</p>
                      </div>
                      <button
                        className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--fg)]"
                        onClick={() => setScanOpen(false)}
                        type="button"
                      >
                        Close
                      </button>
                    </div>
                    <div className="mt-3">
                      <CameraScanner
                        active
                        onScan={(code) => {
                          setForm((p) => ({ ...p, barcode: code }));
                          setScanOpen(false);
                        }}
                      />
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        Point the camera at the barcode. It will fill the barcode field automatically.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {/* Barcode exists indicator */}
              {existingProduct && (
                <div className="mt-2 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2">
                  <p className="text-xs font-semibold text-teal-400">✓ Product found</p>
                  <p className="text-sm text-[var(--fg)]">{existingProduct.name}</p>
                  <p className="text-xs text-[var(--muted)]">
                    Category: {existingProduct.category || "—"} · Current Stock: {existingProduct.stock_qty || 0}
                  </p>
                </div>
              )}
            </div>
          </div>
        
        {addQuantityMode && existingProduct ? (
          // Add quantity mode - product exists
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-4">
              <p className="text-sm font-semibold text-[var(--fg)]">Add Stock Quantity</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Product: <strong>{existingProduct.name}</strong>
              </p>
              <p className="text-xs text-[var(--muted)]">
                Category: <strong>{existingProduct.category || "—"}</strong>
              </p>
              <p className="text-xs text-[var(--muted)]">
                Current Stock: <strong>{existingProduct.stock_qty || 0}</strong>
              </p>
            </div>
            <NumberField
              label="Quantity to add"
              value={quantityToAdd}
              onChange={(v) => setQuantityToAdd(Math.max(0, v))}
            />
            {quantityToAdd > 0 && (
              <div className="rounded-lg border border-[var(--stroke)] bg-[var(--surface)] p-3">
                <p className="text-xs text-[var(--muted)]">
                  New stock will be: <strong className="text-[var(--fg)]">{(existingProduct.stock_qty || 0) + quantityToAdd}</strong>
                </p>
              </div>
            )}
            <button
              className="mt-3 w-full rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={() => mutation.mutate()}
              disabled={mutation.isLoading || quantityToAdd <= 0}
            >
              {mutation.isLoading ? "Adding..." : `Add ${quantityToAdd} to Stock`}
            </button>
            <button
              className="w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--fg)]"
              onClick={() => {
                setForm((p) => ({ ...p, barcode: "" }));
                setAddQuantityMode(false);
                setExistingProduct(null);
                setQuantityToAdd(0);
              }}
            >
              Cancel - Add New Product Instead
            </button>
          </div>
        ) : (
          // New product mode - barcode doesn't exist
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Name"
                value={form.name}
                onChange={(v) => setForm((p) => ({ ...p, name: v }))}
              />
              <TextField
                label="Category"
                value={form.category}
                onChange={(v) => setForm((p) => ({ ...p, category: v }))}
              />
              <NumberField
                label={`Cost Price - Bought at (${currency})`}
                value={form.costPrice}
                onChange={(v) => setForm((p) => ({ ...p, costPrice: v }))}
              />
              <NumberField
                label={`Selling Price - Min (${currency})`}
                value={form.basePrice}
                onChange={(v) => setForm((p) => ({ ...p, basePrice: v }))}
              />
              <NumberField
                label="Stock quantity"
                value={form.stockQty}
                onChange={(v) => setForm((p) => ({ ...p, stockQty: v }))}
              />
              <NumberField
                label="Tax rate (decimal)"
                value={form.taxRate}
                onChange={(v) => setForm((p) => ({ ...p, taxRate: v }))}
              />
              <label className="block">
                <span className="text-xs font-medium text-[var(--muted)]">Expiry date (optional)</span>
                <input
                  type="date"
                  value={form.expiryDate}
                  onChange={(e) => setForm((p) => ({ ...p, expiryDate: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                />
              </label>
            </div>
            <div className="mt-2 text-xs text-[var(--muted)]">
              <strong>Cost Price</strong> = what you paid for the item. <strong>Selling Price</strong> = minimum price employees can sell at (can negotiate higher with customers).
            </div>
            <button
              className="mt-3 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={() => mutation.mutate()}
              disabled={mutation.isLoading || !form.barcode || !form.name}
            >
              {mutation.isLoading ? "Saving..." : "Save product"}
            </button>
          </>
        )}
        </>
      )}

      {productTab === "import" && (
        <div className="mt-4 space-y-2 rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 py-3 text-sm text-[var(--muted)]">
          <p>Import products via CSV: columns (barcode,name,basePrice,costPrice,stockQty,taxRate)</p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportCsv(file);
            }}
            className="text-xs"
          />
          {importStatus && <p className="text-xs text-[var(--muted)]">{importStatus}</p>}
        </div>
      )}

      <div className="mt-5 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Catalog</p>
            <p className="text-sm font-semibold text-[var(--fg)]">
              {filteredProducts.length} products
            </p>
          </div>
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or barcode"
              className="w-64 rounded-md border border-[var(--stroke)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            {search && (
              <button
                className="rounded-md border border-[var(--stroke)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted)]"
                onClick={() => setSearch("")}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {(productTab === "low"
            ? filteredProducts.filter(
                (p) => p.low_stock_alert && p.stock_qty <= (p.low_stock_alert ?? 0)
              )
            : filteredProducts
          ).map((p) => {
            const low = p.low_stock_alert && p.stock_qty <= p.low_stock_alert;
            const barcodeBadge =
              p.barcode && scannedCode && p.barcode.toLowerCase() === scannedCode.toLowerCase();
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-[var(--stroke)] bg-[var(--card)] px-3 py-2"
              >
                <div className="space-y-0.5">
                  <p className="font-semibold text-[var(--fg)]">{p.name}</p>
                  <p className="text-xs text-[var(--muted)]">
                Base {currency} {p.base_price} • Stock {p.stock_qty}
                    {p.barcode ? ` • Barcode ${p.barcode}` : ""}
              </p>
            </div>
                <div className="flex items-center gap-2">
                  {barcodeBadge ? (
                    <span className="accent-chip rounded-full px-2 py-1 text-[11px] font-semibold">
                      Scan matched
                    </span>
                  ) : null}
                  {low ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-500">
                      Low
                    </span>
            ) : null}
          </div>
              </div>
            );
          })}
          {(productTab === "low"
            ? filteredProducts.filter(
                (p) => p.low_stock_alert && p.stock_qty <= (p.low_stock_alert ?? 0)
              ).length === 0
            : filteredProducts.length === 0) && (
            <p className="text-xs text-[var(--muted)]">No products match your search.</p>
          )}
        </div>
      </div>
    </div>
  );
};

const ServiceManager = ({
  currency,
  onSaved,
}: {
  currency: string;
  onSaved: () => void;
}) => {
  const qc = useQueryClient();
  const { data: services } = useQuery<Service[]>({
    queryKey: ["services"],
    queryFn: () => api("/services"),
  });
  const [form, setForm] = useState({
    name: "",
    suggestedPrice: 0,
    taxRate: 0,
    category: "",
    kpiEligible: true,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      await api("/services", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          suggestedPrice: Number(form.suggestedPrice),
          taxRate: Number(form.taxRate),
          category: form.category || undefined,
          kpiEligible: form.kpiEligible,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["services"] });
      onSaved();
      setForm({ name: "", suggestedPrice: 0, taxRate: 0, category: "", kpiEligible: true });
    },
  });

  return (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Services</p>
          <h2 className="text-lg font-semibold">Dynamic pricing</h2>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <TextField
          label="Name"
          value={form.name}
          onChange={(v) => setForm((p) => ({ ...p, name: v }))}
        />
        <NumberField
          label={`Suggested price (${currency})`}
          value={form.suggestedPrice}
          onChange={(v) => setForm((p) => ({ ...p, suggestedPrice: v }))}
        />
        <NumberField
          label="Tax rate (decimal)"
          value={form.taxRate}
          onChange={(v) => setForm((p) => ({ ...p, taxRate: v }))}
        />
        <TextField
          label="Category"
          value={form.category}
          onChange={(v) => setForm((p) => ({ ...p, category: v }))}
        />
        <label className="mt-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
          <input
            type="checkbox"
            checked={form.kpiEligible}
            onChange={(e) => setForm((p) => ({ ...p, kpiEligible: e.target.checked }))}
          />
          KPI eligible
        </label>
      </div>
      <button
        className="mt-3 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
        onClick={() => mutation.mutate()}
        disabled={mutation.isLoading}
      >
        {mutation.isLoading ? "Saving..." : "Save service"}
      </button>

      <div className="mt-4 space-y-2">
        {services?.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded border px-3 py-2">
            <div>
              <p className="font-semibold">{s.name}</p>
              <p className="text-xs text-[var(--muted)]">
                Suggested {currency} {s.suggested_price ?? "-"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const SellScreen = ({
  currency,
  settings,
  branches,
  devices,
  sellers,
  products,
  services,
  onSale,
  scannedCode,
  onScanConsumed,
  onGoProducts,
  branchId,
  deviceId,
  sellerId,
  onBranchChange,
  onDeviceChange,
  onSellerChange,
  businessName,
  branchName,
  sellerName,
}: {
  currency: string;
  settings: Setting;
  branches: Branch[];
  devices: Device[];
  sellers: Seller[];
  products: Product[];
  services: Service[];
  onSale: () => void;
  scannedCode?: string | null;
  onScanConsumed?: () => void;
  onGoProducts?: () => void;
  branchId: string;
  deviceId: string;
  sellerId: string;
  onBranchChange: (id: string) => void;
  onDeviceChange: (id: string) => void;
  onSellerChange: (id: string) => void;
  businessName: string;
  branchName: string;
  sellerName: string;
}) => {
  const [mode, setMode] = useState<"product" | "service">("product");
  const [productSearch, setProductSearch] = useState("");
  const [serviceSearch, setServiceSearch] = useState("");
  const [state, setState] = useState({
    branchId: branchId,
    deviceId: deviceId,
    sellerId: sellerId,
    productId: products[0]?.id ?? "",
    serviceId: services[0]?.id ?? "",
    quantity: 1,
    finalPrice: products[0]?.base_price ?? 0,
    paymentMethod: "cash" as PaymentMethod,
    tenderedCash: 0,
    tenderedTill: 0,
    tenderedBank: 0,
    paymentRef: "",
  });
  const [cart, setCart] = useState<
    {
      kind: "product" | "service";
      id: string;
      name: string;
      base: number;
      final: number;
      qty: number;
      barcode?: string | null;
      note?: string;
      adjustment?: number; // negative = discount, positive = increase
    }[]
  >([]);
  const [receipt, setReceipt] = useState<{
    number: number;
    saleId: string;
    receiptNo: number;
    lines: {
      code: string;
      desc: string;
      qty: number;
      unit: number;
      ext: number;
      taxRate: number;
      vatable: number;
      vat: number;
    }[];
    taxGroups: Record<string, { vatable: number; vat: number }>;
    total: number;
    paymentMethod: PaymentMethod;
    paymentRef?: string;
    tendered: number;
    payments?: { cash: number; till: number; bank: number };
    change: number;
    seller: string;
    branch: string;
    business: string;
    poBox?: string | null;
    town?: string | null;
    telNo?: string | null;
    cuSerialNo?: string | null;
    cuInvoiceNo?: string | null;
    kraPin?: string | null;
    returnPolicy?: string | null;
    tillNumber?: string | null;
    totalItems: number;
    totalWeights: number;
    header?: string | null;
    footer?: string | null;
    logo?: string | null;
    when: string;
    customer?: string;
    customerPhone?: string;
    pointsEarned?: number;
    pointsRedeemed?: number;
  } | null>(null);
  const [receiptLog, setReceiptLog] = useState<typeof receipt[]>([]);
  const [delivery, setDelivery] = useState<"print" | "email">("print");
  const [emailTo, setEmailTo] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const [saleStatus, setSaleStatus] = useState<string | null>(null);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [cartSearch, setCartSearch] = useState("");
  const [parked, setParked] = useState<typeof cart | null>(null);
  const [customer, setCustomer] = useState<{ name: string; contact: string }>({ name: "", contact: "" });
  const [customerPhoneLookup, setCustomerPhoneLookup] = useState("");
  const [customerPoints, setCustomerPoints] = useState<number | null>(null);
  const [redeemPoints, setRedeemPoints] = useState<number>(0);
  const [scanToast, setScanToast] = useState<{ kind: "ok" | "bad"; msg: string } | null>(null);
  const [scanLockUntil, setScanLockUntil] = useState<number>(0);
  const [scanHighlightId, setScanHighlightId] = useState<string | null>(null);
  const qc = useQueryClient();

  // Auto-hide scan toast after 2 seconds
  useEffect(() => {
    if (scanToast) {
      const timer = setTimeout(() => setScanToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [scanToast]);

  const activeProduct = products.find((p) => p.id === state.productId);
  const basePrice = activeProduct?.base_price ?? 0;
  const finalPrice = Math.max(state.finalPrice, basePrice);
  const cartTotals = useMemo(() => {
    const extra = cart.reduce((sum, line) => {
      const base = line.base;
      const adj = Number((line as any).adjustment ?? 0);
      const charge = Math.max(0, line.final + adj);
      const extraLine = Math.max(0, charge - base) * line.qty;
      return sum + extraLine;
    }, 0);
    // Calculate total WITHOUT tax (for UI display)
    // API will calculate total WITH tax for validation
    const total = cart.reduce((sum, line) => {
      const adj = Number((line as any).adjustment ?? 0);
      const charge = Math.max(0, line.final + adj);
      return sum + charge * line.qty;
    }, 0);
    const payCash = Number(state.tenderedCash || 0);
    const payTill = Number(state.tenderedTill || 0);
    const payBank = Number(state.tenderedBank || 0);
    const paid = payCash + payTill + payBank;
    const due = Math.max(total - paid, 0);
    const change = Math.max(0, payCash - Math.max(total - (payTill + payBank), 0));
    return { extra, total, change, due, paid, payCash, payTill, payBank };
  }, [cart, state.tenderedCash, state.tenderedTill, state.tenderedBank]);

  const estimatedPointsEarned = useMemo(() => {
    const rate = settings.loyaltyPointsRate ?? 0.01;
    return cartTotals.total * rate;
  }, [cartTotals.total, settings.loyaltyPointsRate]);

  // Define callbacks BEFORE effects that use them to avoid initialization errors
  const addLineFromProduct = useCallback(
    (product: Product, qty: number, final: number) => {
      setCart((list) => [
        ...list,
        {
          kind: "product" as const,
          id: product.id,
          name: product.name,
          base: product.base_price,
          final: Math.max(final, product.base_price),
          qty: qty,
          barcode: product.barcode,
        },
      ]);
    },
    []
  );

  const addLineFromService = useCallback(
    (service: Service, qty: number, final: number) => {
      setCart((list) => [
        ...list,
        {
          kind: "service" as const,
          id: service.id,
          name: service.name,
          base: 0,
          final,
          qty,
        },
      ]);
    },
    []
  );

  useEffect(() => {
    if (!scannedCode) return;
    
    const now = Date.now();
    if (now < scanLockUntil) {
      onScanConsumed?.();
      return;
    }
    
    // Wait for products to load before attempting match
    if (products.length === 0) {
      setScanToast({ kind: "bad", msg: "Loading products..." });
      setTimeout(() => setScanToast(null), 1500);
      onScanConsumed?.();
      return;
    }
    
    const trimmedCode = scannedCode.trim();
    const match = products.find((p) => 
      (p.barcode ?? "").toLowerCase() === trimmedCode.toLowerCase()
    );
    
    if (match) {
      setScanLockUntil(Date.now() + 3000);
      setMode("product");
      addLineFromProduct(match, 1, match.base_price);
      setScanToast({ kind: "ok", msg: `Added: ${match.name}` });
      setScanHighlightId(match.id);
      setTimeout(() => setScanHighlightId(null), 1500);
      playScanSound(); // Use new scanner sound MP3
      onScanConsumed?.();
      return;
    }
    
    // No match found
    setScanLockUntil(Date.now() + 1500);
    setScanToast({ kind: "bad", msg: `Not found: ${trimmedCode}` });
    playBeep(440, 0.1); // Lower pitch for not found
    onScanConsumed?.();
  }, [scannedCode, products, scanLockUntil, addLineFromProduct, onScanConsumed]);

  useEffect(() => {
    if (!customerPhoneLookup.trim()) {
      setCustomerPoints(null);
      return;
    }
    api<any>(`/customers/lookup?phone=${encodeURIComponent(customerPhoneLookup.trim())}`)
      .then((c) => setCustomerPoints(c?.points ?? null))
      .catch(() => setCustomerPoints(null));
  }, [customerPhoneLookup]);

  useEffect(() => {
    // Always update from props when they have valid values
    setState((p) => ({
      ...p,
      branchId: branchId || branches[0]?.id || p.branchId,
      deviceId: deviceId || devices[0]?.id || p.deviceId,
      sellerId: sellerId || sellers[0]?.id || p.sellerId,
    }));
  }, [branchId, deviceId, sellerId, branches, devices, sellers]);

  // Update productId when products load (async from React Query)
  useEffect(() => {
    if (products.length > 0 && !state.productId) {
      setState((p) => ({
        ...p,
        productId: products[0].id,
        finalPrice: products[0].base_price,
      }));
    }
  }, [products, state.productId]);

  // Update serviceId when services load
  useEffect(() => {
    if (services.length > 0 && !state.serviceId) {
      setState((p) => ({
        ...p,
        serviceId: services[0].id,
      }));
    }
  }, [services, state.serviceId]);

  // Update finalPrice when switching between product/service modes
  useEffect(() => {
    if (mode === "service") {
      const selectedService = services.find((s) => s.id === state.serviceId);
      if (selectedService) {
        setState((p) => ({
          ...p,
          finalPrice: (selectedService as any)?.suggested_price ?? 0,
        }));
      }
    } else if (mode === "product") {
      const selectedProduct = products.find((p) => p.id === state.productId);
      if (selectedProduct) {
        setState((p) => ({
          ...p,
          finalPrice: selectedProduct.base_price,
        }));
      }
    }
  }, [mode, state.serviceId, state.productId, services, products]);

  useEffect(() => {
    const saved = localStorage.getItem("receipt-log");
    if (saved) {
      try {
        setReceiptLog(JSON.parse(saved));
      } catch {
        setReceiptLog([]);
      }
    }
    // Load parked sale (new format with customer info)
    const parkedSale = localStorage.getItem("parked-sale");
    if (parkedSale) {
      try {
        const data = JSON.parse(parkedSale);
        setParked(data.cart || []);
      } catch {
        setParked(null);
      }
    } else {
      // Fallback to old format
      const parkedCart = localStorage.getItem("parked-cart");
      if (parkedCart) {
        try {
          setParked(JSON.parse(parkedCart));
        } catch {
          setParked(null);
        }
      }
    }
  }, []);

  const handleAddLine = () => {
    if (mode === "product") {
      const product = products.find((p) => p.id === state.productId);
      if (!product) return;
      const dup = cart.find((l) => l.kind === "product" && l.id === product.id && l.final === finalPrice);
      if (dup) {
        updateCartLine(cart.indexOf(dup), (l) => ({ ...l, qty: l.qty + state.quantity }));
        return;
      }
      addLineFromProduct(product, state.quantity, finalPrice);
    } else {
      const service = services.find((s) => s.id === state.serviceId);
      if (!service) return;
      const unit = Number(state.finalPrice || 0);
      if (unit <= 0) {
        showToast("Enter a service unit price above 0", "warning");
        return;
      }
      addLineFromService(service, state.quantity, unit);
    }
  };

  const updateCartLine = (idx: number, updater: (line: (typeof cart)[number]) => (typeof cart)[number]) => {
    setCart((list) => list.map((line, i) => (i === idx ? updater(line) : line)));
  };

  const removeCartLine = (idx: number) => {
    setCart((list) => list.filter((_, i) => i !== idx));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (cart.length === 0) {
        throw new Error("Cart is empty");
      }
      // Payment validation with floating point tolerance (same logic as API)
      const epsilon = 0.01;
      if (cartTotals.due > epsilon) {
        throw new Error("Payment is incomplete. Cover the full total before posting.");
      }
      if (redeemPoints > 0 && customerPoints !== null && redeemPoints > customerPoints) {
        throw new Error("Redeem points exceed available balance");
      }
      const items = cart.map((line) => {
        const adj = Number((line as any).adjustment ?? 0);
        const raw = Math.max(0, Number(line.final) + adj);
        const effective = line.kind === "product" ? Math.max(raw, Number(line.base || 0)) : raw;
        return {
          kind: line.kind,
          itemId: line.id,
          quantity: Number(line.qty),
          finalPrice: effective,
          note: line.note || undefined,
          adjustment: adj || undefined,
        };
      });
      const result = await api<{ saleId: string; receiptNo: number; totalAmount: number; totalTax: number; pointsEarned?: number; pointsRedeemed?: number }>(
        "/sales",
        {
        method: "POST",
        body: JSON.stringify({
          branchId: state.branchId || branches[0]?.id,
          deviceId: state.deviceId || devices[0]?.id,
          sellerId: state.sellerId || sellers[0]?.id,
          paymentMethod: cartTotals.payTill || cartTotals.payBank ? "split" : state.paymentMethod,
          paymentRef: state.paymentRef || undefined,
          tendered: cartTotals.paid,
          change: cartTotals.change,
          payments: {
            cash: cartTotals.payCash,
            till: cartTotals.payTill,
            bank: cartTotals.payBank,
          },
          customer:
            customer.name || customer.contact || redeemPoints
              ? { name: customer.name || undefined, phone: customer.contact || customerPhoneLookup || undefined, redeemPoints: redeemPoints || undefined }
              : undefined,
          items,
        }),
        }
      );
      return result;
    },
    onSuccess: (saleResult) => {
      setSaleError(null);
      setSaleStatus(`Sale posted. Receipt #${saleResult?.receiptNo ?? "—"} ready.`);
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["reports", "kpi"] });
      onSale();
      const nextNumber = (() => {
        const current = Number(localStorage.getItem("receipt-counter") || "1000");
        const next = current + 1;
        localStorage.setItem("receipt-counter", String(next));
        return next;
      })();

      const deviceNameForReceipt =
        devices.find((d) => d.id === (state.deviceId || devices[0]?.id))?.name ?? (state.deviceId || "—");

      const lines = cart.map((line) => {
        const taxRate =
          line.kind === "product"
            ? products.find((p) => p.id === line.id)?.tax_rate ?? 0
            : services.find((s) => s.id === line.id)?.tax_rate ?? 0;
        const adj = Number((line as any).adjustment ?? 0);
        const raw = Math.max(0, Number(line.final) + adj);
        const unitNet = line.kind === "product" ? Math.max(raw, Number(line.base || 0)) : raw;
        const unitTax = unitNet * (taxRate || 0);
        const unitInc = unitNet + unitTax;
        const ext = unitInc * Number(line.qty);
        const taxAmt = unitTax * Number(line.qty);
        const code = line.kind === "product" ? String(line.barcode || line.id).slice(0, 12) : `SVC-${String(line.id).slice(0, 6)}`;
        return {
          code,
          desc: line.name,
          qty: Number(line.qty),
          unit: unitInc,
          ext,
          taxRate,
          vatable: unitNet * Number(line.qty),
          vat: taxAmt,
        };
      });

      const taxGroups: Record<string, { vatable: number; vat: number }> = {};
      for (const ln of lines) {
        const k = `VAT${Math.round((ln.taxRate || 0) * 100)}`;
        taxGroups[k] = taxGroups[k] || { vatable: 0, vat: 0 };
        taxGroups[k].vatable += ln.vatable;
        taxGroups[k].vat += ln.vat;
      }

      const totalItems = lines.reduce((s, l) => s + l.qty, 0);
      const totalWeights = lines.reduce((s, l) => (Number.isInteger(l.qty) ? s : s + l.qty), 0);

      const newReceipt = {
        number: nextNumber,
        saleId: saleResult?.saleId ?? "",
        receiptNo: saleResult?.receiptNo ?? nextNumber,
        lines,
        taxGroups,
        total: saleResult?.totalAmount ?? cartTotals.total,
        paymentMethod: cartTotals.payTill || cartTotals.payBank ? "split" : state.paymentMethod,
        paymentRef: state.paymentRef || undefined,
        tendered: cartTotals.paid,
        payments: {
          cash: cartTotals.payCash,
          till: cartTotals.payTill,
          bank: cartTotals.payBank,
        },
        change: cartTotals.change,
        seller: sellerName,
        branch: branchName,
        business: businessName,
        header: settings?.receiptHeader,
        footer: settings?.receiptFooter,
        logo: settings?.logoPath,
        poBox: settings?.poBox,
        town: settings?.town,
        telNo: settings?.telNo,
        cuSerialNo: settings?.cuSerialNo,
        cuInvoiceNo: settings?.cuInvoiceNo,
        kraPin: settings?.kraPin,
        returnPolicy: settings?.returnPolicy,
        loyaltyPointsRate: settings?.loyaltyPointsRate ?? 0.01,
        tillNumber: deviceNameForReceipt,
        totalItems,
        totalWeights,
        customer: customer.name ? customer.name : undefined,
        customerPhone: customer.contact || customerPhoneLookup || undefined,
        pointsEarned: saleResult?.pointsEarned ?? 0,
        pointsRedeemed: saleResult?.pointsRedeemed ?? 0,
        customerPointsAfter:
          customerPoints !== null
            ? Math.max(0, customerPoints + (saleResult?.pointsEarned ?? 0) - (saleResult?.pointsRedeemed ?? 0))
            : undefined,
        when: new Date().toLocaleString(),
      };
      setReceipt(newReceipt);
      setReceiptLog((prev) => {
        const updated = [newReceipt, ...prev].slice(0, 50);
        localStorage.setItem("receipt-log", JSON.stringify(updated));
        return updated;
      });
      setCart([]);
      setState((p) => ({
        ...p,
        tenderedCash: 0,
        tenderedTill: 0,
        tenderedBank: 0,
        paymentRef: "",
      }));
      // Auto-scroll to receipt and trigger print dialog after a short delay
      setTimeout(() => {
        document.getElementById("receipt-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
        // Auto-trigger print dialog after receipt is rendered (500ms delay for rendering)
        setTimeout(() => {
          // Get app version from API if available, otherwise use default
          const api = (window as any).api;
          const getAppVersion = async () => {
            try {
              return await api?.appVersion?.() || "0.1.1";
            } catch {
              return "0.1.1";
            }
          };
          getAppVersion().then((appVer) => {
            const html = receiptHtml(newReceipt, currency, appVer);
            const w = window.open("", "_blank");
            if (w) {
              w.document.open();
              w.document.write(html);
              w.document.close();
              w.focus();
              setTimeout(() => w.print(), 250);
            } else {
              // Fallback: print current page if popup blocked
              window.print();
            }
          });
        }, 500);
      }, 100);
    },
    onError: (err: any) => {
      setSaleStatus(null);
      setSaleError(err?.message ?? "Failed to post sale");
    },
  });

  useEffect(() => {
    if (!receipt) return;
    document.getElementById("receipt-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [receipt]);

  const filteredProducts = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    if (!term) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.barcode ?? "").toLowerCase().includes(term)
    );
  }, [products, productSearch]);

  const filteredServices = useMemo(() => {
    const term = serviceSearch.trim().toLowerCase();
    if (!term) return services;
    return services.filter((s) => s.name.toLowerCase().includes(term));
  }, [services, serviceSearch]);

  const matched = scannedCode
    ? products.find((p) => (p.barcode ?? "").toLowerCase() === scannedCode.toLowerCase())
    : null;

  useEffect(() => {
    if (mode === "product") {
      setState((p) => ({
        ...p,
        finalPrice: products.find((prod) => prod.id === p.productId)?.base_price ?? p.finalPrice,
      }));
    }
  }, [mode, state.productId, products]);

  return (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      {scanToast && (
        <div
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            scanToast.kind === "ok"
              ? "border-teal-500/40 bg-teal-500/10 text-teal-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">{scanToast.msg}</span>
            <div className="flex items-center gap-2">
              {scanToast.kind === "bad" && (
                <button
                  className="rounded-md bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)] border border-[var(--stroke)]"
                  onClick={() => onGoProducts?.()}
                  type="button"
                >
                  Add product
                </button>
              )}
              <button
                className="rounded-md bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)] border border-[var(--stroke)]"
                onClick={() => setScanToast(null)}
                type="button"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Sell</p>
          <h2 className="text-lg font-semibold text-[var(--fg)]">Products & Services</h2>
          <p className="text-xs text-[var(--muted)]">
            Served by: <span className="font-semibold text-[var(--fg)]">
              {sellers.find((s) => s.id === state.sellerId)?.name ?? "Seller"}
            </span>{" "}
            • Branch {branches.find((b) => b.id === state.branchId)?.name ?? "—"} • Device{" "}
            {state.deviceId || "—"}
          </p>
        </div>
        {scannedCode && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              matched ? "accent-chip" : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}
          >
            {matched ? "Matched" : "Not found"} · {scannedCode}
          </span>
        )}
      </div>

      <div className="mt-3 flex gap-2 text-sm">
        <button
          className={`rounded-md px-3 py-1 ${
            mode === "product" ? "bg-teal-600 text-white" : "bg-[var(--surface)] text-[var(--fg)]"
          }`}
          onClick={() => setMode("product")}
        >
          Product
        </button>
        <button
          className={`rounded-md px-3 py-1 ${
            mode === "service" ? "bg-teal-600 text-white" : "bg-[var(--surface)] text-[var(--fg)]"
          }`}
          onClick={() => {
            setMode("service");
            // Immediately update finalPrice to selected service's suggested_price
            const selectedService = services.find((s) => s.id === state.serviceId);
            if (selectedService) {
              setState((p) => ({
                ...p,
                finalPrice: (selectedService as any)?.suggested_price ?? 0,
              }));
            }
          }}
        >
          Service
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Branch"
          value={state.branchId}
          onChange={(v) => {
            setState((p) => ({ ...p, branchId: v }));
            onBranchChange(v);
          }}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <SelectField
          label="Device"
          value={state.deviceId}
          onChange={(v) => {
            setState((p) => ({ ...p, deviceId: v }));
            onDeviceChange(v);
          }}
          options={devices.map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectField
          label="Seller"
          value={state.sellerId}
          onChange={(v) => {
            setState((p) => ({ ...p, sellerId: v }));
            onSellerChange(v);
          }}
          options={sellers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <SelectField
          label="Payment mode"
          value={state.paymentMethod}
          onChange={(v) => {
            const mode = v as PaymentMethod | "split";
            setState((p) => ({
              ...p,
              paymentMethod: mode as PaymentMethod,
              tenderedCash: mode === "cash" ? p.tenderedCash : 0,
              tenderedTill: mode === "till" ? p.tenderedTill : 0,
              tenderedBank: mode === "bank" ? p.tenderedBank : 0,
            }));
          }}
          options={[
            { value: "cash", label: "Cash" },
            { value: "till", label: "Till (M-Pesa)" },
            { value: "bank", label: "Bank" },
            { value: "split", label: "Split" },
          ]}
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <NumberField
            label={`Cash amount (${currency})`}
            value={state.tenderedCash}
            onChange={(v) => setState((p) => ({ ...p, tenderedCash: v }))}
          />
          <NumberField
            label={`Till amount (${currency})`}
            value={state.tenderedTill}
            onChange={(v) => setState((p) => ({ ...p, tenderedTill: v }))}
          />
          <NumberField
            label={`Bank amount (${currency})`}
            value={state.tenderedBank}
            onChange={(v) => setState((p) => ({ ...p, tenderedBank: v }))}
          />
          <TextField
            label="Payment reference (optional)"
            value={state.paymentRef}
            onChange={(v) => setState((p) => ({ ...p, paymentRef: v }))}
          />
        </div>

        {mode === "product" ? (
          <>
            <div className="space-y-1">
              <SelectField
                label="Product (scan/search)"
                value={state.productId}
                onChange={(v) => {
                  const selected = products.find((p) => p.id === v);
                  // Switch to product mode when a product is selected
                  setMode("product");
                  setState((p) => ({
                    ...p,
                    productId: v,
                    finalPrice: selected?.base_price ?? p.finalPrice,
                  }));
                }}
                options={filteredProducts.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${currency} ${p.base_price})`,
                }))}
              />
              <input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search by name or barcode"
                className="w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            {/* Price info box */}
            <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--muted)]">Base Price (Min)</span>
                <span className="font-bold text-teal-400">{currency} {basePrice.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-[var(--muted)]">Stock: {activeProduct?.stock_qty ?? 0}</span>
                <button
                  type="button"
                  onClick={() => setState((p) => ({ ...p, finalPrice: basePrice }))}
                  className="rounded bg-teal-600 px-2 py-0.5 text-white text-xs font-medium"
                >
                  Use Base Price
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
          <SelectField
            label="Service"
            value={state.serviceId}
                onChange={(v) => {
                  const s = services.find((x) => x.id === v);
                  // Switch to service mode when a service is selected
                  setMode("service");
                  setState((p) => ({
                    ...p,
                    serviceId: v,
                    finalPrice: (s as any)?.suggested_price ?? 0,
                  }));
                }}
                options={filteredServices.map((s) => ({ value: s.id, label: s.name }))}
              />
              <input
                value={serviceSearch}
                onChange={(e) => setServiceSearch(e.target.value)}
                placeholder="Search service"
                className="w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div className="rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)]">
              <div className="flex items-center justify-between">
                <span>Dynamic price</span>
                <span className="font-semibold text-[var(--fg)]">No base floor</span>
              </div>
            </div>
          </>
        )}

        <NumberField
          label="Quantity"
          value={state.quantity}
          onChange={(v) => setState((p) => ({ ...p, quantity: v }))}
        />
        
        {/* Final Price with negotiation */}
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--muted)]">
            Selling Price ({currency}) {mode === "product" && state.finalPrice > basePrice && (
              <span className="text-teal-400 ml-1">+{(state.finalPrice - basePrice).toLocaleString()} above base</span>
            )}
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={state.finalPrice}
              onChange={(e) => setState((p) => ({ ...p, finalPrice: Number(e.target.value) }))}
              className={`flex-1 rounded-md border px-3 py-2 text-sm text-[var(--fg)] ${
                mode === "product" && state.finalPrice < basePrice
                  ? "border-red-500 bg-red-500/10"
                  : state.finalPrice === basePrice
                  ? "border-teal-500 bg-teal-500/10"
                  : "border-[var(--stroke)] bg-[var(--surface)]"
              }`}
            />
            {mode === "product" && (
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setState((p) => ({ ...p, finalPrice: basePrice }))}
                  className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                  title="Set to base price"
                >
                  Base
                </button>
                <button
                  type="button"
                  onClick={() => setState((p) => ({ ...p, finalPrice: Math.round(basePrice * 1.1) }))}
                  className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                  title="+10%"
                >
                  +10%
                </button>
                <button
                  type="button"
                  onClick={() => setState((p) => ({ ...p, finalPrice: Math.round(basePrice * 1.2) }))}
                  className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                  title="+20%"
                >
                  +20%
                </button>
              </div>
            )}
          </div>
          {mode === "product" && state.finalPrice < basePrice && (
            <p className="mt-1 text-xs text-red-400">Price cannot be below base ({currency} {basePrice})</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          onClick={handleAddLine}
          disabled={mode === "product" && state.finalPrice < basePrice}
        >
          Add to Cart
        </button>
        <input
          value={cartSearch}
          onChange={(e) => setCartSearch(e.target.value)}
          placeholder="Search cart"
          className="w-48 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm"
        />
      </div>

      <div className="mt-4 rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Cart</h3>
          <p className="text-xs text-[var(--muted)]">Items: {cart.length}</p>
        </div>
        <div className="mt-2 overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-2 py-1">Item</th>
                <th className="px-2 py-1">Barcode/Type</th>
                <th className="px-2 py-1">Qty</th>
                <th className="px-2 py-1">Base</th>
                <th className="px-2 py-1">Final</th>
                <th className="px-2 py-1">Adjust</th>
                <th className="px-2 py-1">Extra</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
            {cart
              .filter((line) => {
                if (!cartSearch) return true;
                const term = cartSearch.toLowerCase();
                return line.name.toLowerCase().includes(term) || (line.barcode ?? "").toLowerCase().includes(term);
              })
              .map((line, idx) => {
                const adj = Number((line as any).adjustment ?? 0);
                const chargeRaw = Math.max(0, line.final + adj);
                const charge = line.kind === "product" ? Math.max(chargeRaw, line.base) : chargeRaw;
                const extra = Math.max(0, charge - line.base) * line.qty;
                const highlight = line.id === scanHighlightId;
                return (
                  <tr
                    key={`${line.id}-${idx}`}
                    className={`border-t border-[var(--stroke)] ${highlight ? "bg-emerald-500/10" : ""}`}
                  >
                    <td className="px-2 py-1 text-[var(--fg)]">{line.name}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">
                      {line.kind === "product" ? line.barcode ?? "—" : "Service"}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={1}
                        value={line.qty}
                        onChange={(e) =>
                          updateCartLine(idx, (l) => ({ ...l, qty: Math.max(1, Number(e.target.value)) }))
                        }
                        className="w-16 rounded-md border border-[var(--stroke)] bg-[var(--card)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1 text-[var(--muted)]">
                      {line.kind === "product" ? `🔒 ${currency} ${line.base}` : "—"}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={line.final}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          updateCartLine(idx, (l) => ({
                            ...l,
                            final: l.kind === "product" ? Math.max(val, l.base) : val,
                          }));
                        }}
                        className="w-24 rounded-md border border-[var(--stroke)] bg-[var(--card)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={(line as any).adjustment ?? 0}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          updateCartLine(idx, (l) => ({
                            ...l,
                            adjustment: Number.isFinite(val) ? val : 0,
                          }));
                        }}
                        className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--card)] px-2 py-1 text-[var(--fg)]"
                      />
                      <p className="mt-1 text-[10px] text-[var(--muted)]">-discount / +increase</p>
                    </td>
                    <td className="px-2 py-1 text-emerald-400">{currency} {extra.toFixed(2)}</td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={line.note ?? ""}
                        onChange={(e) =>
                          updateCartLine(idx, (l) => ({ ...l, note: e.target.value }))
                        }
                        placeholder="Note"
                        className="w-28 rounded-md border border-[var(--stroke)] bg-[var(--card)] px-2 py-1 text-[11px] text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        className="text-xs text-red-400"
                        onClick={() => removeCartLine(idx)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {cart.length === 0 && (
                <tr>
                  <td className="px-2 py-2 text-xs text-[var(--muted)]" colSpan={7}>
                    Cart is empty. Add a product or service.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-3">
        <p className="text-sm font-medium text-[var(--fg)]">Totals</p>
        <p className="text-sm text-[var(--muted)]">
          Extra value: <span className="font-semibold text-emerald-400">{currency} {cartTotals.extra.toFixed(2)}</span>
        </p>
        <p className="text-sm text-[var(--muted)]">
          Total: <span className="font-semibold text-[var(--fg)]">{currency} {cartTotals.total.toFixed(2)}</span>
        </p>
        <p className="text-sm text-[var(--muted)]">
          Paid: <span className="font-semibold text-[var(--fg)]">{currency} {cartTotals.paid.toFixed(2)}</span>
          {" · "}Cash {currency} {cartTotals.payCash.toFixed(2)}
          {" · "}Till {currency} {cartTotals.payTill.toFixed(2)}
          {" · "}Bank {currency} {cartTotals.payBank.toFixed(2)}
        </p>
        <p className="text-sm text-[var(--muted)]">
          Change: <span className="font-semibold text-[var(--fg)]">{currency} {cartTotals.change.toFixed(2)}</span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
          <span>Amount due: {currency} {cartTotals.due.toFixed(2)}</span>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            onClick={() => setState((p) => ({ ...p, tenderedCash: cartTotals.total, tenderedTill: 0, tenderedBank: 0, paymentMethod: "cash" }))}
          >
            Cash exact
          </button>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            onClick={() => setState((p) => ({ ...p, tenderedCash: cartTotals.total + 50, tenderedTill: 0, tenderedBank: 0, paymentMethod: "cash" }))}
          >
            Cash +50
          </button>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            onClick={() => setState((p) => ({ ...p, tenderedCash: cartTotals.total + 100, tenderedTill: 0, tenderedBank: 0, paymentMethod: "cash" }))}
          >
            Cash +100
          </button>
        </div>
      </div>

      <button
        className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        onClick={() => mutation.mutate()}
        disabled={mutation.isLoading || !state.branchId || !state.deviceId || !state.sellerId || cart.length === 0}
      >
        {mutation.isLoading ? "Posting sale..." : "Post sale"}
      </button>
      {saleError && <p className="mt-2 text-sm text-red-400">{saleError}</p>}
      {saleStatus && <p className="mt-2 text-sm text-emerald-400">{saleStatus}</p>}

      {/* Customer Info Section */}
      <div className="mt-4 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3">
        <p className="text-xs font-semibold text-[var(--muted)] mb-2">Customer Details (Optional)</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            placeholder="Customer name"
            value={customer.name}
            onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))}
            className="w-full rounded-md border border-[var(--stroke)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)]"
          />
          <input
            placeholder="Phone / Contact"
            value={customer.contact}
            onChange={(e) => setCustomer((c) => ({ ...c, contact: e.target.value }))}
            className="w-full rounded-md border border-[var(--stroke)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)]"
          />
        </div>
      </div>

      {/* Park / Resume Sale Section */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-400 hover:bg-amber-500/20 disabled:opacity-40"
          onClick={() => {
            const parkedData = { cart, customer };
            localStorage.setItem("parked-sale", JSON.stringify(parkedData));
            setParked(cart);
            setCart([]);
            setCustomer({ name: "", contact: "" });
            playBeep(660, 0.1);
          }}
          disabled={cart.length === 0}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          Park Sale
        </button>
        <button
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${
            parked
              ? "border border-teal-500/50 bg-teal-500/10 text-teal-400 hover:bg-teal-500/20"
              : "border border-[var(--stroke)] bg-[var(--surface)] text-[var(--muted)]"
          } disabled:opacity-40`}
          onClick={() => {
            try {
              const saved = localStorage.getItem("parked-sale");
              if (saved) {
                const data = JSON.parse(saved);
                setCart(data.cart || []);
                setCustomer(data.customer || { name: "", contact: "" });
                setParked(null);
                localStorage.removeItem("parked-sale");
                localStorage.removeItem("parked-cart");
                playBeep(880, 0.1);
              } else if (parked) {
                setCart(parked);
                setParked(null);
                localStorage.removeItem("parked-cart");
                playBeep(880, 0.1);
              }
            } catch {
              // ignore parse errors
            }
          }}
          disabled={!parked && !localStorage.getItem("parked-sale")}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Resume Sale
          {parked && (
            <span className="ml-1 rounded-full bg-teal-600 px-2 py-0.5 text-xs text-white">
              {parked.length} item{parked.length !== 1 ? "s" : ""}
            </span>
          )}
        </button>
        {parked && (
          <span className="text-xs text-[var(--muted)]">
            Parked sale waiting ({parked.reduce((s, i) => s + i.qty, 0)} items)
          </span>
        )}
      </div>

      {receiptLog.length > 0 && (
        <div className="mt-4 rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--fg)]">Recent receipts</p>
            <span className="text-xs text-[var(--muted)]">Last {receiptLog.length}</span>
          </div>
          <div className="mt-2 space-y-2">
            {receiptLog.map((r) => (
              <div key={r.number} className="flex items-center justify-between rounded-md border border-[var(--stroke)] px-3 py-2">
                <div className="text-xs text-[var(--muted)]">
                  #{r.number} • {r.business} • {r.when}
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                    onClick={() => setReceipt(r)}
                  >
                    View
                  </button>
                  <button
                    className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                    onClick={() => {
                      setReceipt(r);
                      window.print();
                    }}
                  >
                    Reprint
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {receipt && (
        <div className="mt-4 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>Delivery:</span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={delivery === "print"}
              onChange={() => setDelivery("print")}
            />
            Print
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={delivery === "email"}
              onChange={() => setDelivery("email")}
            />
            Email
          </label>
          {delivery === "email" && (
            <input
              type="email"
              placeholder="customer@example.com"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className="w-56 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            />
          )}
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--fg)]"
            onClick={async () => {
              if (!receipt) return;
              if (delivery === "print") {
                window.print();
                setDeliveryStatus("Sent to printer.");
                return;
              }
              if (!emailTo) {
                setDeliveryStatus("Enter an email.");
                return;
              }
              try {
                await api("/receipts/email", {
                  method: "POST",
                  body: JSON.stringify({ to: emailTo, receipt }),
                });
                setDeliveryStatus("Email sent.");
              } catch (err: any) {
                setDeliveryStatus("Email failed (check SMTP config).");
              }
            }}
          >
            Send
          </button>
          {deliveryStatus && <span>{deliveryStatus}</span>}
        </div>
      )}

      {receipt && (
        <div id="receipt-panel">
          <ReceiptPanel receipt={receipt} currency={currency} />
        </div>
      )}
    </div>
  );
};

const KpiBoard = ({ data, currency }: { data: any[]; currency: string }) => (
  <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">KPI</p>
        <h2 className="text-lg font-semibold text-[var(--fg)]">Per-seller performance</h2>
      </div>
    </div>
    <div className="mt-4 space-y-3">
      {data.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No KPI data yet. Record a sale.</p>
      )}
      {data.map((row) => (
        <div
          key={row.seller_id}
          className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-3"
        >
          <p className="text-sm font-semibold text-[var(--fg)]">{row.seller_name}</p>
          <p className="text-xs text-[var(--muted)]">
            Points: {row.points} • Extra: {currency} {row.extra_value} • Services:{" "}
            {row.services_sold}
          </p>
        </div>
      ))}
    </div>
  </div>
);

const Card = ({ title, value, note }: { title: string; value: string; note?: string }) => (
  <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
    <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{title}</p>
    <p className="mt-1 text-2xl font-semibold text-[var(--fg)]">{value}</p>
    {note && <p className="text-xs text-[var(--muted)]">{note}</p>}
  </div>
);

// Pages
const AdminDashboardPage = ({
  settings,
  branches,
  devices,
  sellers,
  products,
  services,
  kpi,
}: {
  settings: Setting;
  branches: Branch[];
  devices: Device[];
  sellers: Seller[];
  products: Product[];
  services: Service[];
  kpi: any[];
}) => {
  const end = Date.now();
  const start = end - 30 * 24 * 60 * 60 * 1000;
  const analyticsQ = useQuery({
    queryKey: ["reports", "analytics", start, end],
    queryFn: () => api<any>(`/reports/analytics?start=${start}&end=${end}&limit=8`),
  });
  const dailyQ = useQuery({
    queryKey: ["reports", "daily-accounts", start, end],
    queryFn: () => api<any[]>(`/reports/daily-accounts?start=${start}&end=${end}`),
  });
  const payMixQ = useQuery({
    queryKey: ["reports", "payment-mix"],
    queryFn: () => api<{ cash: number; till: number; bank: number; total: number }>(`/reports/payment-mix`),
  });

  const BarList = ({
    title,
    rows,
    keyField,
  }: {
    title: string;
    rows: any[];
    keyField: string;
  }) => {
    const max = Math.max(1, ...(rows ?? []).map((r) => Number(r.net_amount ?? 0)));
    const total = (rows ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const colors = ["#0d9488", "#2563eb", "#a855f7", "#f59e0b", "#ef4444", "#22c55e", "#ec4899", "#06b6d4"];
    
    return (
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">Last 30 days</p>
          </div>
          {total > 0 && (
            <div className="text-right">
              <p className="text-lg font-bold text-[var(--fg)]">{settings.currency} {total.toLocaleString()}</p>
              <p className="text-xs text-[var(--muted)]">{(rows ?? []).length} items</p>
            </div>
          )}
        </div>
        <div className="mt-4 space-y-3">
          {(rows ?? []).slice(0, 8).map((r: any, idx: number) => {
            const name = r[keyField] ?? r.name ?? "—";
            const amount = Number(r.net_amount ?? 0);
            const qty = Number(r.qty ?? 0);
            const pct = Math.round((amount / max) * 100);
            const color = colors[idx % colors.length];
            return (
              <div key={`${keyField}-${name}`} className="group">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 rounded-sm flex-shrink-0"
                      style={{ background: color }}
                    />
                    <span className="text-sm font-medium text-[var(--fg)] truncate max-w-[140px]">{name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[var(--muted)]">{qty} sold</span>
                    <span className="font-semibold text-[var(--fg)] tabular-nums">
                      {settings.currency} {amount.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="h-2 w-full rounded-full bg-[var(--surface)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${color}, ${color}dd)`,
                    }}
                  />
                </div>
              </div>
            );
          })}
          {(rows ?? []).length === 0 && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-[var(--surface)] flex items-center justify-center">
                <svg className="h-5 w-5 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                </svg>
              </div>
              <p className="text-xs text-[var(--muted)]">No data yet. Make sales to see top performers.</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const formatMoney = (n: number) => `${settings.currency} ${Number(n || 0).toFixed(0)}`;

  const TrendCharts = ({ rows }: { rows: any[] }) => {
    const data = [...(rows ?? [])]
      .filter((r) => r && r.day)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const labels = data.map((r) => String(r.day).slice(5)); // MM-DD
    const totals = data.map((r) => Number(r.total ?? 0));
    const profit = data.map((r) => Number(r.profit ?? 0));
    const cash = data.map((r) => Number(r.cash ?? 0));
    const till = data.map((r) => Number(r.till ?? 0));
    const bank = data.map((r) => Number(r.bank ?? 0));

    if (data.length === 0) {
      return (
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-8 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-[var(--surface)] flex items-center justify-center">
            <svg className="h-6 w-6 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h4 className="text-sm font-semibold text-[var(--fg)]">No sales data yet</h4>
          <p className="mt-1 text-xs text-[var(--muted)]">Make some sales to see trends and analytics here.</p>
        </div>
      );
    }

    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Sales Trend</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">Daily revenue over the last 30 days</p>
          <MiniLineChart
            labels={labels}
            series={[{ name: "Revenue", color: "#0d9488", values: totals }]}
            currency={settings.currency}
          />
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Profit Trend</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">Daily profit over the last 30 days</p>
          <MiniLineChart
            labels={labels}
            series={[{ name: "Profit", color: "#22c55e", values: profit }]}
            currency={settings.currency}
          />
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm lg:col-span-2">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Payment Methods</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">Daily breakdown by payment type</p>
          <MiniStackedBars
            labels={labels}
            stacks={[
              { name: "Cash", color: "#0d9488", values: cash },
              { name: "Till", color: "#2563eb", values: till },
              { name: "Bank", color: "#a855f7", values: bank },
            ]}
            currency={settings.currency}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
    <PageHeading
      id="dashboard"
      title="Dashboard"
      subtitle="Decision-ready metrics with offline resilience."
    />
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card title="Products" value={`${products.length}`} note="Tracked" />
      <Card title="Services" value={`${services.length}`} note="Dynamic" />
      <Card title="Branches" value={`${branches.length}`} note="Active" />
      <Card title="Devices" value={`${devices.length}`} note="Local" />
    </section>
    <section className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm lg:col-span-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">Payment mix</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">Cash vs Till vs Bank (all time)</p>
          </div>
        </div>
        {payMixQ.isLoading ? (
          <p className="text-xs text-[var(--muted)] mt-2">Loading…</p>
        ) : payMixQ.isError ? (
          <p className="text-xs text-red-400 mt-2">{(payMixQ.error as any)?.message ?? "Failed"}</p>
        ) : (
          <div className="mt-3 space-y-2 text-xs text-[var(--muted)]">
            {["cash","till","bank"].map((k) => {
              const val = Number((payMixQ.data as any)?.[k] ?? 0);
              const total = Math.max(1, Number((payMixQ.data as any)?.total ?? 0));
              const pct = Math.round((val / total) * 100);
              const color = k === "cash" ? "#0d9488" : k === "till" ? "#2563eb" : "#a855f7";
              const label = k === "cash" ? "Cash" : k === "till" ? "Till (M-Pesa)" : "Bank";
              return (
                <div key={k}>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--fg)] font-semibold">{label}</span>
                    <span>{settings.currency} {val.toFixed(2)} • {pct}%</span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded-full bg-[var(--surface)]">
                    <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Low stock</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">Below alert level</p>
        <div className="mt-2 space-y-2 text-xs text-[var(--muted)] max-h-56 overflow-auto">
          {products
            .filter((p) => p.low_stock_alert && p.stock_qty <= (p.low_stock_alert ?? 0))
            .slice(0, 10)
            .map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1">
                <span className="text-[var(--fg)] font-semibold">{p.name}</span>
                <span>Stock {p.stock_qty} / Alert {p.low_stock_alert}</span>
              </div>
            ))}
          {products.filter((p) => p.low_stock_alert && p.stock_qty <= (p.low_stock_alert ?? 0)).length === 0 && (
            <p className="text-xs text-[var(--muted)]">No low-stock items.</p>
          )}
        </div>
      </div>
    </section>
    <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fg)]">Trends</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Quick view of sales and profit over time (offline).
          </p>
        </div>
        <div className="text-xs text-[var(--muted)]">
          Scope: all branches • {formatMoney((dailyQ.data ?? []).reduce((s, r: any) => s + Number(r.total ?? 0), 0))} total (30d)
        </div>
      </div>
      <div className="mt-3">
        {dailyQ.isLoading ? (
          <p className="text-xs text-[var(--muted)]">Loading charts…</p>
        ) : dailyQ.isError ? (
          <p className="text-xs text-red-400">{(dailyQ.error as any)?.message ?? "Failed to load charts"}</p>
        ) : (
          <TrendCharts rows={dailyQ.data ?? []} />
        )}
      </div>
    </section>
    <section className="grid gap-4 lg:grid-cols-2">
      <KpiBoard currency={settings.currency} data={kpi ?? []} />
      <BarList title="Top categories" rows={analyticsQ.data?.topCategories ?? []} keyField="category" />
    </section>
    <section className="grid gap-4 lg:grid-cols-2">
      <BarList title="Top products" rows={analyticsQ.data?.topProducts ?? []} keyField="name" />
      <BarList title="Top services" rows={analyticsQ.data?.topServices ?? []} keyField="name" />
    </section>
  </div>
  );
};

const MiniLineChart = ({
  labels,
  series,
  currency = "",
}: {
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  currency?: string;
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const w = 760;
  const h = 260;
  const pad = 36;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2 - 20;

  const all = series.flatMap((s) => s.values);
  const maxV = Math.max(1, ...all.map((v) => Number(v || 0)));
  const total = series[0]?.values.reduce((s, v) => s + Number(v || 0), 0) || 0;

  const x = (i: number) => pad + (labels.length <= 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
  const y = (v: number) => pad + innerH - (Number(v || 0) / maxV) * innerH;

  const grid = 5;
  const gridLines = Array.from({ length: grid + 1 }, (_, i) => {
    const yy = pad + (i / grid) * innerH;
    const val = Math.round(maxV * (1 - i / grid));
    return (
      <g key={i}>
        <line x1={pad} y1={yy} x2={pad + innerW} y2={yy} stroke="rgba(148,163,184,0.15)" strokeDasharray="4,4" />
        <text x={pad - 8} y={yy + 4} textAnchor="end" fontSize="9" fill="rgba(148,163,184,0.6)">
          {val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
        </text>
      </g>
    );
  });

  // Create smooth curve path
  const createSmoothPath = (values: number[]) => {
    if (values.length < 2) return "";
    const points = values.map((v, i) => ({ x: x(i), y: y(v) }));
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      path += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
    }
    return path;
  };

  // Create gradient fill path
  const createFillPath = (values: number[]) => {
    const linePath = createSmoothPath(values);
    if (!linePath) return "";
    const lastX = x(values.length - 1);
    const firstX = x(0);
    const bottomY = pad + innerH;
    return `${linePath} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  };

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[var(--stroke)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg)]">
      {/* Summary stats */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-4">
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              <span className="text-xs text-[var(--muted)]">{s.name}</span>
            </div>
          ))}
        </div>
        <div className="text-xs text-[var(--muted)]">
          Total: <span className="font-semibold text-[var(--fg)]">{currency} {total.toLocaleString()}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-52 w-full" onMouseLeave={() => setHoveredIndex(null)}>
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`gradient-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {gridLines}
        {series.map((s, si) => (
          <g key={si}>
            {/* Gradient fill area */}
            <path d={createFillPath(s.values)} fill={`url(#gradient-${si})`} />
            {/* Line */}
            <path
              d={createSmoothPath(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.1))" }}
            />
            {/* Data points */}
            {s.values.map((v, i) => (
              <g key={i}>
                <circle
                  cx={x(i)}
                  cy={y(v)}
                  r={hoveredIndex === i ? 6 : 4}
                  fill={s.color}
                  stroke="var(--card)"
                  strokeWidth="2"
                  style={{ cursor: "pointer", transition: "r 0.15s ease" }}
                  onMouseEnter={() => setHoveredIndex(i)}
                />
                {/* Invisible larger hit area */}
                <circle
                  cx={x(i)}
                  cy={y(v)}
                  r="15"
                  fill="transparent"
                  onMouseEnter={() => setHoveredIndex(i)}
                />
              </g>
            ))}
          </g>
        ))}
        {/* Tooltip */}
        {hoveredIndex !== null && series[0]?.values[hoveredIndex] !== undefined && (
          <g>
            <line
              x1={x(hoveredIndex)}
              y1={pad}
              x2={x(hoveredIndex)}
              y2={pad + innerH}
              stroke="rgba(148,163,184,0.3)"
              strokeDasharray="4,4"
            />
            <rect
              x={x(hoveredIndex) - 50}
              y={y(series[0].values[hoveredIndex]) - 40}
              width="100"
              height="32"
              rx="6"
              fill="var(--card)"
              stroke="var(--stroke)"
              style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.15))" }}
            />
            <text
              x={x(hoveredIndex)}
              y={y(series[0].values[hoveredIndex]) - 26}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill="var(--fg)"
            >
              {currency} {Number(series[0].values[hoveredIndex]).toLocaleString()}
            </text>
            <text
              x={x(hoveredIndex)}
              y={y(series[0].values[hoveredIndex]) - 13}
              textAnchor="middle"
              fontSize="9"
              fill="rgba(148,163,184,0.8)"
            >
              {labels[hoveredIndex]}
            </text>
          </g>
        )}
        {/* X-axis labels */}
        {labels.map((lab, i) => {
          if (labels.length > 14 && i % Math.ceil(labels.length / 7) !== 0 && i !== labels.length - 1) return null;
          return (
            <text key={i} x={x(i)} y={h - 8} textAnchor="middle" fontSize="9" fill="rgba(148,163,184,0.7)">
              {lab}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

const MiniStackedBars = ({
  labels,
  stacks,
  currency = "",
}: {
  labels: string[];
  stacks: { name: string; color: string; values: number[] }[];
  currency?: string;
}) => {
  const [hoveredBar, setHoveredBar] = useState<{ index: number; total: number; breakdown: { name: string; value: number; color: string }[] } | null>(null);
  const w = 760;
  const h = 260;
  const pad = 36;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2 - 20;

  const totals = labels.map((_, i) => stacks.reduce((s, st) => s + Number(st.values[i] ?? 0), 0));
  const maxV = Math.max(1, ...totals);
  const gap = 4;
  const barW = labels.length ? Math.max(8, (innerW - (labels.length - 1) * gap) / labels.length) : 20;

  const grid = 5;
  const gridLines = Array.from({ length: grid + 1 }, (_, i) => {
    const yy = pad + (i / grid) * innerH;
    const val = Math.round(maxV * (1 - i / grid));
    return (
      <g key={i}>
        <line x1={pad} y1={yy} x2={pad + innerW} y2={yy} stroke="rgba(148,163,184,0.15)" strokeDasharray="4,4" />
        <text x={pad - 8} y={yy + 4} textAnchor="end" fontSize="9" fill="rgba(148,163,184,0.6)">
          {val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
        </text>
      </g>
    );
  });

  const grandTotal = totals.reduce((s, t) => s + t, 0);

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[var(--stroke)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg)]">
      {/* Summary stats */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-4">
          {stacks.map((s) => {
            const stackTotal = s.values.reduce((sum, v) => sum + Number(v || 0), 0);
            return (
              <div key={s.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded" style={{ background: s.color }} />
                <span className="text-xs text-[var(--muted)]">
                  {s.name}: <span className="font-medium text-[var(--fg)]">{currency} {stackTotal.toLocaleString()}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="text-xs text-[var(--muted)]">
          Total: <span className="font-semibold text-[var(--fg)]">{currency} {grandTotal.toLocaleString()}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-52 w-full" onMouseLeave={() => setHoveredBar(null)}>
        <defs>
          {stacks.map((st, si) => (
            <linearGradient key={si} id={`bar-gradient-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={st.color} stopOpacity="1" />
              <stop offset="100%" stopColor={st.color} stopOpacity="0.7" />
            </linearGradient>
          ))}
        </defs>
        {gridLines}
        {labels.map((_, i) => {
          const tx = pad + i * (barW + gap);
          let yCursor = pad + innerH;
          const isHovered = hoveredBar?.index === i;
          return (
            <g
              key={i}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => {
                const breakdown = stacks.map((st) => ({
                  name: st.name,
                  value: Number(st.values[i] ?? 0),
                  color: st.color,
                }));
                setHoveredBar({ index: i, total: totals[i], breakdown });
              }}
            >
              {/* Background bar for hover area */}
              <rect
                x={tx}
                y={pad}
                width={barW}
                height={innerH}
                fill="transparent"
              />
              {stacks.map((st, si) => {
                const v = Number(st.values[i] ?? 0);
                const hh = (v / maxV) * innerH;
                yCursor -= hh;
                return (
                  <rect
                    key={si}
                    x={tx}
                    y={yCursor}
                    width={barW}
                    height={hh}
                    rx="2"
                    fill={`url(#bar-gradient-${si})`}
                    opacity={isHovered ? 1 : 0.85}
                    style={{
                      transition: "opacity 0.15s ease, transform 0.15s ease",
                      filter: isHovered ? "brightness(1.1)" : "none",
                    }}
                  />
                );
              })}
            </g>
          );
        })}
        {/* Tooltip */}
        {hoveredBar && (
          <g>
            <rect
              x={pad + hoveredBar.index * (barW + gap) + barW / 2 - 70}
              y={Math.max(10, pad - 60)}
              width="140"
              height={24 + hoveredBar.breakdown.length * 16}
              rx="6"
              fill="var(--card)"
              stroke="var(--stroke)"
              style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.15))" }}
            />
            <text
              x={pad + hoveredBar.index * (barW + gap) + barW / 2}
              y={Math.max(10, pad - 60) + 16}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill="var(--fg)"
            >
              {labels[hoveredBar.index]} - {currency} {hoveredBar.total.toLocaleString()}
            </text>
            {hoveredBar.breakdown.map((item, bi) => (
              <g key={item.name}>
                <rect
                  x={pad + hoveredBar.index * (barW + gap) + barW / 2 - 60}
                  y={Math.max(10, pad - 60) + 24 + bi * 16}
                  width="8"
                  height="8"
                  rx="2"
                  fill={item.color}
                />
                <text
                  x={pad + hoveredBar.index * (barW + gap) + barW / 2 - 48}
                  y={Math.max(10, pad - 60) + 32 + bi * 16}
                  fontSize="9"
                  fill="rgba(148,163,184,0.9)"
                >
                  {item.name}: {currency} {item.value.toLocaleString()}
                </text>
              </g>
            ))}
          </g>
        )}
        {/* X-axis labels */}
        {labels.map((lab, i) => {
          if (labels.length > 14 && i % Math.ceil(labels.length / 7) !== 0 && i !== labels.length - 1) return null;
          const tx = pad + i * (barW + gap) + barW / 2;
          return (
            <text key={i} x={tx} y={h - 8} textAnchor="middle" fontSize="9" fill="rgba(148,163,184,0.7)">
              {lab}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

// ==================== ADMIN INVENTORY PAGE ====================
type PendingProduct = {
  id: string;
  barcode: string;
  name: string;
  qty: number;
  price?: number;
  status: "pending" | "matched" | "added";
};

const AdminInventoryPage = ({
  currency,
  products,
  scannedCode,
  onScanConsumed,
}: {
  currency: string;
  products: Product[];
  scannedCode: string | null;
  onScanConsumed: () => void;
}) => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "movements" | "bulk" | "adjustments">("overview");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "stock" | "category">("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  
  // Bulk upload state
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkPreview, setBulkPreview] = useState<{ matched: any[]; pending: PendingProduct[] } | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ updated: number; added: number; failed: number } | null>(null);
  const [pendingProducts, setPendingProducts] = useState<PendingProduct[]>([]);
  
  // Barcode scanner for pending products
  const [scannerActive, setScannerActive] = useState(false);
  const [selectedPending, setSelectedPending] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BrowserMultiFormatReader | null>(null);
  
  // Adjustment modal
  const [adjustModal, setAdjustModal] = useState<{ open: boolean; product: Product | null; qty: number; reason: string }>({
    open: false,
    product: null,
    qty: 0,
    reason: "",
  });

  // Inventory movements query
  const movementsQ = useQuery<any[]>({
    queryKey: ["inventory-movements"],
    queryFn: () => api("/inventory-movements"),
  });

  // Handle scanned code from parent
  useEffect(() => {
    if (scannedCode && selectedPending) {
      setPendingProducts((prev) =>
        prev.map((p) =>
          p.id === selectedPending ? { ...p, barcode: scannedCode, status: "pending" } : p
        )
      );
      onScanConsumed();
      setSelectedPending(null);
      playBeep(880, 0.15);
    }
  }, [scannedCode, selectedPending, onScanConsumed]);

  // Camera scanner for pending products - optimized for blur/dim light
  const startScanner = async () => {
    if (!videoRef.current) return;
    try {
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE,
      ]);
      scannerRef.current = new BrowserMultiFormatReader(hints);
      await scannerRef.current.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          if (result && selectedPending) {
            const code = result.getText();
            setPendingProducts((prev) =>
              prev.map((p) =>
                p.id === selectedPending ? { ...p, barcode: code, status: "pending" } : p
              )
            );
            setSelectedPending(null);
            playBeep(880, 0.15);
            stopScanner();
          }
        }
      );
      setScannerActive(true);
    } catch (err) {
      console.error("Scanner error:", err);
    }
  };

  const stopScanner = () => {
    if (scannerRef.current) {
      scannerRef.current.reset();
      scannerRef.current = null;
    }
    setScannerActive(false);
  };

  // Parse CSV/Excel file
  const parseFile = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { matched: [], pending: [] };
    
    // Expect format: barcode,name,quantity,price (price optional)
    const matched: any[] = [];
    const pending: PendingProduct[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 2) continue;
      
      const [barcode, name, qtyStr, priceStr] = cols;
      const qty = Number(qtyStr) || 0;
      const price = priceStr ? Number(priceStr) : undefined;
      
      // Try to match by barcode first, then by name
      const matchByBarcode = products.find(
        (p) => p.barcode && p.barcode.toLowerCase() === barcode.toLowerCase()
      );
      const matchByName = products.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      
      const match = matchByBarcode || matchByName;
      
      if (match) {
        matched.push({
          product: match,
          newQty: qty,
          addQty: qty, // qty to add to existing
          matchedBy: matchByBarcode ? "barcode" : "name",
        });
      } else {
        pending.push({
          id: `pending-${i}-${Date.now()}`,
          barcode: barcode || "",
          name: name || "",
          qty,
          price,
          status: "pending",
        });
      }
    }
    
    return { matched, pending };
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkFile(file);
    setBulkResult(null);
    
    const preview = await parseFile(file);
    setBulkPreview(preview);
    setPendingProducts(preview.pending);
  };

  const executeBulkUpload = async () => {
    if (!bulkPreview) return;
    setBulkUploading(true);
    
    let updated = 0;
    let added = 0;
    let failed = 0;
    
    // Update matched products
    for (const item of bulkPreview.matched) {
      try {
        await api(`/products/${item.product.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            stock_qty: item.product.stock_qty + item.addQty,
          }),
        });
        updated++;
      } catch {
        failed++;
      }
    }
    
    // Add pending products that have barcodes assigned
    for (const item of pendingProducts) {
      if (item.status === "added") continue;
      if (!item.barcode || !item.name) continue;
      
      try {
        await api("/products", {
          method: "POST",
          body: JSON.stringify({
            barcode: item.barcode,
            name: item.name,
            basePrice: item.price ?? 0,
            stockQty: item.qty,
            taxRate: 0,
            costPrice: 0,
          }),
        });
        setPendingProducts((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, status: "added" } : p))
        );
        added++;
      } catch {
        failed++;
      }
    }
    
    setBulkUploading(false);
    setBulkResult({ updated, added, failed });
    qc.invalidateQueries({ queryKey: ["products"] });
  };

  const adjustStock = async () => {
    if (!adjustModal.product) return;
    try {
      await api(`/products/${adjustModal.product.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          stock_qty: adjustModal.product.stock_qty + adjustModal.qty,
        }),
      });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["inventory-movements"] });
      setAdjustModal({ open: false, product: null, qty: 0, reason: "" });
    } catch (e: any) {
      showToast(e?.message ?? "Failed to adjust stock", "error");
    }
  };

  const sorted = useMemo(() => {
    let list = [...products];
    if (search.trim()) {
      const term = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.barcode ?? "").toLowerCase().includes(term) ||
          ((p as any).category ?? "").toLowerCase().includes(term)
      );
    }
    list.sort((a, b) => {
      const mult = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return mult * a.name.localeCompare(b.name);
      if (sortKey === "stock") return mult * (a.stock_qty - b.stock_qty);
      return mult * ((a as any).category ?? "").localeCompare((b as any).category ?? "");
    });
    return list;
  }, [products, sortKey, sortDir, search]);

  const lowStockCount = products.filter((p) => p.low_stock_alert && p.stock_qty <= p.low_stock_alert).length;
  const totalStock = products.reduce((s, p) => s + p.stock_qty, 0);
  const totalValue = products.reduce((s, p) => s + p.stock_qty * p.base_price, 0);

  return (
    <div className="space-y-4">
      <PageHeading
        id="inventory"
        title="Inventory Management"
        subtitle="Full control over stock levels, bulk imports, and inventory movements."
      />

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <p className="text-xs text-[var(--muted)]">Total Products</p>
          <p className="mt-1 text-2xl font-bold text-[var(--fg)]">{products.length}</p>
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <p className="text-xs text-[var(--muted)]">Total Stock Units</p>
          <p className="mt-1 text-2xl font-bold text-[var(--fg)]">{totalStock.toLocaleString()}</p>
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <p className="text-xs text-[var(--muted)]">Stock Value</p>
          <p className="mt-1 text-2xl font-bold text-[var(--fg)]">{currency} {totalValue.toLocaleString()}</p>
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <p className="text-xs text-[var(--muted)]">Low Stock Items</p>
          <p className={`mt-1 text-2xl font-bold ${lowStockCount > 0 ? "text-red-400" : "text-teal-400"}`}>
            {lowStockCount}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[var(--stroke)] pb-2">
        {(["overview", "bulk", "movements", "adjustments"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-semibold rounded-t-lg ${
              tab === t
                ? "bg-teal-600 text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t === "overview" ? "Stock Overview" : t === "bulk" ? "Bulk Import" : t === "movements" ? "Movements" : "Adjustments"}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {tab === "overview" && (
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h3 className="text-sm font-semibold text-[var(--fg)]">All Products</h3>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
              />
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as any)}
                className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--fg)]"
              >
                <option value="name">Sort: Name</option>
                <option value="stock">Sort: Stock</option>
                <option value="category">Sort: Category</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
              >
                {sortDir === "asc" ? "Asc" : "Desc"}
              </button>
            </div>
          </div>
          <div className="overflow-auto max-h-[500px]">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--muted)] border-b border-[var(--stroke)] sticky top-0 bg-[var(--card)]">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Barcode</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2">Stock</th>
                  <th className="px-3 py-2">Low Alert</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const low = p.low_stock_alert && p.stock_qty <= p.low_stock_alert;
                  return (
                    <tr key={p.id} className={`border-t border-[var(--stroke)] ${low ? "bg-red-500/10" : ""}`}>
                      <td className="px-3 py-2 text-[var(--fg)] font-medium">{p.name}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{(p as any).category ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--muted)] font-mono text-xs">{p.barcode ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--fg)]">{currency} {p.base_price.toLocaleString()}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{currency} {((p as any).cost_price ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <span className={`font-semibold ${low ? "text-red-400" : "text-[var(--fg)]"}`}>
                          {p.stock_qty}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[var(--muted)]">{p.low_stock_alert ?? "—"}</td>
                      <td className="px-3 py-2">
                        {low ? (
                          <span className="inline-flex items-center rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                            Low
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-teal-500/20 px-2 py-0.5 text-xs font-medium text-teal-400">
                            OK
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setAdjustModal({ open: true, product: p, qty: 0, reason: "" })}
                          className="rounded-md bg-[var(--surface)] border border-[var(--stroke)] px-2 py-1 text-xs text-[var(--fg)]"
                        >
                          Adjust
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk Import Tab */}
      {tab === "bulk" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-[var(--fg)]">Bulk Stock Import</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Upload a CSV file with columns: <code className="bg-[var(--surface)] px-1 rounded">barcode,name,quantity,price</code>
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Products will be matched by barcode first, then by name. Unmatched items go to pending for manual barcode assignment.
            </p>
            <div className="mt-4 flex items-center gap-4">
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleFileSelect}
                className="text-sm text-[var(--fg)]"
              />
              {bulkFile && (
                <span className="text-xs text-[var(--muted)]">{bulkFile.name}</span>
              )}
            </div>
          </div>

          {bulkPreview && (
            <>
              {/* Matched Products */}
              <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-teal-400">
                    Matched Products ({bulkPreview.matched.length})
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  These products were found and their stock will be updated.
                </p>
                {bulkPreview.matched.length > 0 ? (
                  <div className="mt-3 overflow-auto max-h-60">
                    <table className="min-w-full text-left text-sm">
                      <thead className="text-[var(--muted)] border-b border-[var(--stroke)]">
                        <tr>
                          <th className="px-3 py-2">Product</th>
                          <th className="px-3 py-2">Matched By</th>
                          <th className="px-3 py-2">Current Stock</th>
                          <th className="px-3 py-2">Add Qty</th>
                          <th className="px-3 py-2">New Stock</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkPreview.matched.map((m, i) => (
                          <tr key={i} className="border-t border-[var(--stroke)]">
                            <td className="px-3 py-2 text-[var(--fg)]">{m.product.name}</td>
                            <td className="px-3 py-2">
                              <span className="rounded-full bg-teal-500/20 px-2 py-0.5 text-xs text-teal-400">
                                {m.matchedBy}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[var(--muted)]">{m.product.stock_qty}</td>
                            <td className="px-3 py-2 text-teal-400">+{m.addQty}</td>
                            <td className="px-3 py-2 font-semibold text-[var(--fg)]">
                              {m.product.stock_qty + m.addQty}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[var(--muted)]">No matched products.</p>
                )}
              </div>

              {/* Pending Products */}
              <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-amber-400">
                    Pending Products ({pendingProducts.filter((p) => p.status !== "added").length})
                  </h3>
                  {pendingProducts.length > 0 && (
                    <button
                      onClick={scannerActive ? stopScanner : startScanner}
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                        scannerActive ? "bg-red-600 text-white" : "bg-teal-600 text-white"
                      }`}
                    >
                      {scannerActive ? "Stop Scanner" : "Start Scanner"}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  These products were not found. Assign barcodes using the scanner, then they will be added as new products.
                </p>

                {scannerActive && (
                  <div className="mt-3 rounded-lg overflow-hidden border border-[var(--stroke)]">
                    <video ref={videoRef} className="w-full max-h-48 object-cover" />
                    <p className="bg-[var(--surface)] px-3 py-2 text-xs text-center text-[var(--muted)]">
                      {selectedPending
                        ? `Scanning barcode for: ${pendingProducts.find((p) => p.id === selectedPending)?.name}`
                        : "Select a product to scan its barcode"}
                    </p>
                  </div>
                )}

                {pendingProducts.filter((p) => p.status !== "added").length > 0 ? (
                  <div className="mt-3 overflow-auto max-h-60">
                    <table className="min-w-full text-left text-sm">
                      <thead className="text-[var(--muted)] border-b border-[var(--stroke)]">
                        <tr>
                          <th className="px-3 py-2">Name</th>
                          <th className="px-3 py-2">Barcode</th>
                          <th className="px-3 py-2">Qty</th>
                          <th className="px-3 py-2">Price</th>
                          <th className="px-3 py-2">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingProducts
                          .filter((p) => p.status !== "added")
                          .map((p) => (
                            <tr
                              key={p.id}
                              className={`border-t border-[var(--stroke)] ${
                                selectedPending === p.id ? "bg-teal-500/10" : ""
                              }`}
                            >
                              <td className="px-3 py-2 text-[var(--fg)]">{p.name}</td>
                              <td className="px-3 py-2">
                                <input
                                  type="text"
                                  value={p.barcode}
                                  onChange={(e) =>
                                    setPendingProducts((prev) =>
                                      prev.map((pp) =>
                                        pp.id === p.id ? { ...pp, barcode: e.target.value } : pp
                                      )
                                    )
                                  }
                                  placeholder="Enter or scan..."
                                  className="w-32 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                                />
                              </td>
                              <td className="px-3 py-2 text-[var(--muted)]">{p.qty}</td>
                              <td className="px-3 py-2 text-[var(--muted)]">
                                {p.price ? `${currency} ${p.price}` : "—"}
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => setSelectedPending(selectedPending === p.id ? null : p.id)}
                                  className={`rounded-md px-2 py-1 text-xs ${
                                    selectedPending === p.id
                                      ? "bg-teal-600 text-white"
                                      : "bg-[var(--surface)] border border-[var(--stroke)] text-[var(--fg)]"
                                  }`}
                                >
                                  {selectedPending === p.id ? "Scanning..." : "Scan"}
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[var(--muted)]">No pending products.</p>
                )}
              </div>

              {/* Execute Button */}
              <div className="flex items-center gap-4">
                <button
                  onClick={executeBulkUpload}
                  disabled={bulkUploading}
                  className="rounded-md bg-teal-600 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {bulkUploading ? "Processing..." : "Execute Bulk Import"}
                </button>
                {bulkResult && (
                  <div className="text-sm">
                    <span className="text-teal-400">{bulkResult.updated} updated</span>
                    {" • "}
                    <span className="text-blue-400">{bulkResult.added} added</span>
                    {bulkResult.failed > 0 && (
                      <>
                        {" • "}
                        <span className="text-red-400">{bulkResult.failed} failed</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Movements Tab */}
      {tab === "movements" && (
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Inventory Movements</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">Track all stock changes: sales, adjustments, returns, and additions.</p>
          <div className="mt-4 overflow-auto max-h-[500px]">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--muted)] border-b border-[var(--stroke)] sticky top-0 bg-[var(--card)]">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Change</th>
                  <th className="px-3 py-2">Before</th>
                  <th className="px-3 py-2">After</th>
                  <th className="px-3 py-2">By</th>
                </tr>
              </thead>
              <tbody>
                {(movementsQ.data ?? []).slice(0, 100).map((m: any) => {
                  const product = products.find((p) => p.id === m.product_id);
                  const isPositive = m.quantity_change > 0;
                  return (
                    <tr key={m.id} className="border-t border-[var(--stroke)]">
                      <td className="px-3 py-2 text-[var(--muted)] text-xs">
                        {new Date(m.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-[var(--fg)]">{product?.name ?? m.product_id}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            m.movement_type === "sale"
                              ? "bg-blue-500/20 text-blue-400"
                              : m.movement_type === "return"
                              ? "bg-amber-500/20 text-amber-400"
                              : m.movement_type === "adjustment"
                              ? "bg-purple-500/20 text-purple-400"
                              : "bg-teal-500/20 text-teal-400"
                          }`}
                        >
                          {m.movement_type}
                        </span>
                      </td>
                      <td className={`px-3 py-2 font-semibold ${isPositive ? "text-teal-400" : "text-red-400"}`}>
                        {isPositive ? "+" : ""}{m.quantity_change}
                      </td>
                      <td className="px-3 py-2 text-[var(--muted)]">{m.before_qty}</td>
                      <td className="px-3 py-2 text-[var(--fg)]">{m.after_qty}</td>
                      <td className="px-3 py-2 text-[var(--muted)] text-xs">{m.performed_by_name || "System"}</td>
                    </tr>
                  );
                })}
                {(movementsQ.data ?? []).length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-sm text-[var(--muted)]" colSpan={7}>
                      No inventory movements recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Adjustments Tab */}
      {tab === "adjustments" && (
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Quick Stock Adjustments</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">Select a product to adjust its stock level.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.slice(0, 30).map((p) => {
              const low = p.low_stock_alert && p.stock_qty <= p.low_stock_alert;
              return (
                <div
                  key={p.id}
                  className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                    low
                      ? "border-red-500/50 bg-red-500/5 hover:bg-red-500/10"
                      : "border-[var(--stroke)] hover:bg-[var(--surface)]"
                  }`}
                  onClick={() => setAdjustModal({ open: true, product: p, qty: 0, reason: "" })}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[var(--fg)] text-sm">{p.name}</span>
                    <span className={`font-semibold ${low ? "text-red-400" : "text-teal-400"}`}>
                      {p.stock_qty}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {p.barcode ?? "No barcode"} • Alert: {p.low_stock_alert ?? "—"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Adjust Modal */}
      {adjustModal.open && adjustModal.product && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-[var(--fg)]">Adjust Stock</h3>
            <p className="mt-1 text-sm text-[var(--muted)]">{adjustModal.product.name}</p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs text-[var(--muted)]">Current Stock</label>
                <p className="text-lg font-semibold text-[var(--fg)]">{adjustModal.product.stock_qty}</p>
              </div>
              <div>
                <label className="text-xs text-[var(--muted)]">Adjustment (+ or -)</label>
                <input
                  type="number"
                  value={adjustModal.qty}
                  onChange={(e) => setAdjustModal((p) => ({ ...p, qty: Number(e.target.value) }))}
                  className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-[var(--fg)]"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--muted)]">New Stock</label>
                <p className="text-lg font-semibold text-teal-400">
                  {adjustModal.product.stock_qty + adjustModal.qty}
                </p>
              </div>
              <div>
                <label className="text-xs text-[var(--muted)]">Reason (optional)</label>
                <input
                  type="text"
                  value={adjustModal.reason}
                  onChange={(e) => setAdjustModal((p) => ({ ...p, reason: e.target.value }))}
                  placeholder="e.g., Damaged, Recount, Received..."
                  className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-[var(--fg)]"
                />
              </div>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setAdjustModal({ open: false, product: null, qty: 0, reason: "" })}
                className="flex-1 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--fg)]"
              >
                Cancel
              </button>
              <button
                onClick={adjustStock}
                className="flex-1 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
              >
                Save Adjustment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ==================== END ADMIN INVENTORY PAGE ====================

const ProductsPage = ({
  currency,
  products,
  scannedCode,
  onScanConsumed,
  canEdit = false,
  lowStockSoundEnabled = true,
}: {
  currency: string;
  products: Product[];
  scannedCode: string | null;
  onScanConsumed: () => void;
  canEdit?: boolean;
  lowStockSoundEnabled?: boolean;
}) => {
  const [drafts, setDrafts] = useState<Record<string, Partial<Product>>>({});
  const [lowBulk, setLowBulk] = useState<number>(0);
  const [sortKey, setSortKey] = useState<"name" | "base" | "stock">("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const [pinOpen, setPinOpen] = useState(false);
  const [pinVal, setPinVal] = useState("");
  const pinResolver = useRef<((v: string | null) => void) | null>(null);
  const [lowStockAlerted, setLowStockAlerted] = useState<Set<string>>(new Set());

  // Low-stock sound alert: play beep when new products fall below threshold
  useEffect(() => {
    if (!lowStockSoundEnabled) return;
    const lowStockItems = products.filter(
      (p) => p.low_stock_alert && p.stock_qty <= p.low_stock_alert
    );
    const newLowStock = lowStockItems.filter((p) => !lowStockAlerted.has(p.id));
    if (newLowStock.length > 0) {
      playBeep(660, 0.3); // Lower pitch for low-stock warning
      setLowStockAlerted((prev) => {
        const next = new Set(prev);
        newLowStock.forEach((p) => next.add(p.id));
        return next;
      });
    }
  }, [products, lowStockSoundEnabled, lowStockAlerted]);

  const hashPin = async (val: string) => {
    const enc = new TextEncoder().encode(val);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const requireAdminPin = useCallback(async () => {
    const stored = localStorage.getItem("admin-pin-hash");
    if (!stored) return true;
    const pin = await new Promise<string | null>((resolve) => {
      pinResolver.current = resolve;
      setPinVal("");
      setPinOpen(true);
    });
    if (!pin) return false;
    const attempt = await hashPin(pin);
    if (attempt !== stored) {
      showToast("Invalid PIN", "error");
      return false;
    }
    return true;
  }, []);

  const addAudit = useCallback((entry: string) => {
    const log = JSON.parse(localStorage.getItem("audit-log") || "[]") as string[];
    log.unshift(`${new Date().toLocaleString()} • ${entry}`);
    localStorage.setItem("audit-log", JSON.stringify(log.slice(0, 200)));
  }, []);

  const updateProduct = async (id: string, patch: Partial<Product>) => {
    const original = products.find((p) => p.id === id);
    if (!(await requireAdminPin())) return;
    await api(`/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    qc.invalidateQueries({ queryKey: ["products"] });
    if (original) {
      addAudit(
        `Product ${original.name} updated: ${JSON.stringify(patch)}`
      );
    }
  };

  const bulkUpdateLow = async () => {
    if (!(await requireAdminPin())) return;
    const value = Number(lowBulk);
    if (Number.isNaN(value)) return;
    const tasks = products.map((p) =>
      api(`/products/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ low_stock_alert: value }),
      }).catch(() => null)
    );
    await Promise.all(tasks);
    qc.invalidateQueries({ queryKey: ["products"] });
    addAudit(`Bulk low-stock set to ${value} for ${products.length} products`);
  };

  const sorted = useMemo(() => {
    let list = [...products];
    // Apply search filter
    if (search.trim()) {
      const term = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.barcode ?? "").toLowerCase().includes(term) ||
          ((p as any).category ?? "").toLowerCase().includes(term)
      );
    }
    list.sort((a, b) => {
      const mult = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return mult * a.name.localeCompare(b.name);
      if (sortKey === "base") return mult * (a.base_price - b.base_price);
      return mult * (a.stock_qty - b.stock_qty);
    });
    return list;
  }, [products, sortKey, sortDir, search]);

  // Bulk stock upload state for sellers
  const [bulkTab, setBulkTab] = useState<"view" | "upload">("view");
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkPreview, setBulkPreview] = useState<{ matched: any[]; pending: any[] } | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ updated: number; added: number; failed: number } | null>(null);
  const [pendingItems, setPendingItems] = useState<PendingProduct[]>([]);
  const [scannerActive, setScannerActive] = useState(false);
  const [selectedPending, setSelectedPending] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BrowserMultiFormatReader | null>(null);

  // Handle scanned code for pending products
  useEffect(() => {
    if (scannedCode && selectedPending) {
      setPendingItems((prev) =>
        prev.map((p) =>
          p.id === selectedPending ? { ...p, barcode: scannedCode } : p
        )
      );
      onScanConsumed();
      setSelectedPending(null);
      playBeep(880, 0.15);
    }
  }, [scannedCode, selectedPending, onScanConsumed]);

  const startScanner = async () => {
    if (!videoRef.current) return;
    try {
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE,
      ]);
      scannerRef.current = new BrowserMultiFormatReader(hints);
      await scannerRef.current.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          if (result && selectedPending) {
            const code = result.getText();
            setPendingItems((prev) =>
              prev.map((p) =>
                p.id === selectedPending ? { ...p, barcode: code } : p
              )
            );
            setSelectedPending(null);
            playBeep(880, 0.15);
            stopScanner();
          }
        }
      );
      setScannerActive(true);
    } catch (err) {
      console.error("Scanner error:", err);
    }
  };

  const stopScanner = () => {
    if (scannerRef.current) {
      scannerRef.current.reset();
      scannerRef.current = null;
    }
    setScannerActive(false);
  };

  const parseCSV = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { matched: [], pending: [] };
    
    const matched: any[] = [];
    const pending: PendingProduct[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 2) continue;
      
      const [barcode, name, qtyStr, priceStr] = cols;
      const qty = Number(qtyStr) || 0;
      const price = priceStr ? Number(priceStr) : undefined;
      
      const matchByBarcode = products.find(
        (p) => p.barcode && p.barcode.toLowerCase() === barcode.toLowerCase()
      );
      const matchByName = products.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      
      const match = matchByBarcode || matchByName;
      
      if (match) {
        matched.push({
          product: match,
          addQty: qty,
          matchedBy: matchByBarcode ? "barcode" : "name",
        });
      } else {
        pending.push({
          id: `pending-${i}-${Date.now()}`,
          barcode: barcode || "",
          name: name || "",
          qty,
          price,
          status: "pending",
        });
      }
    }
    
    return { matched, pending };
  };

  const handleBulkFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkFile(file);
    setBulkResult(null);
    
    const preview = await parseCSV(file);
    setBulkPreview(preview);
    setPendingItems(preview.pending);
  };

  const executeBulkUpload = async () => {
    if (!bulkPreview) return;
    setBulkUploading(true);
    
    let updated = 0;
    let added = 0;
    let failed = 0;
    
    // Update matched products
    for (const item of bulkPreview.matched) {
      try {
        await api(`/products/${item.product.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            stock_qty: item.product.stock_qty + item.addQty,
          }),
        });
        updated++;
      } catch {
        failed++;
      }
    }
    
    // Add pending products that have barcodes
    for (const item of pendingItems) {
      if (item.status === "added") continue;
      if (!item.barcode || !item.name) continue;
      
      try {
        await api("/products", {
          method: "POST",
          body: JSON.stringify({
            barcode: item.barcode,
            name: item.name,
            basePrice: item.price ?? 0,
            stockQty: item.qty,
            taxRate: 0,
            costPrice: 0,
          }),
        });
        setPendingItems((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, status: "added" } : p))
        );
        added++;
      } catch {
        failed++;
      }
    }
    
    setBulkUploading(false);
    setBulkResult({ updated, added, failed });
    qc.invalidateQueries({ queryKey: ["products"] });
  };

  // Edit request state
  const [editRequestOpen, setEditRequestOpen] = useState(false);
  const [editRequestProduct, setEditRequestProduct] = useState<Product | null>(null);
  const [editRequestType, setEditRequestType] = useState<"stock_adjustment" | "price_change" | "product_edit" | "other">("stock_adjustment");
  const [editRequestReason, setEditRequestReason] = useState("");
  const [editRequestValue, setEditRequestValue] = useState("");
  const [editRequestBusy, setEditRequestBusy] = useState(false);
  
  const submitEditRequest = async () => {
    if (!editRequestProduct || !editRequestReason.trim()) return;
    setEditRequestBusy(true);
    try {
      await api("/edit-requests", {
        method: "POST",
        body: JSON.stringify({
          productId: editRequestProduct.id,
          requestType: editRequestType,
          reason: editRequestReason.trim(),
          requestedField: editRequestType === "stock_adjustment" ? "stock_qty" : editRequestType === "price_change" ? "base_price" : "name",
          currentValue: String(
            editRequestType === "stock_adjustment" ? editRequestProduct.stock_qty :
            editRequestType === "price_change" ? editRequestProduct.base_price :
            editRequestProduct.name
          ),
          requestedValue: editRequestValue || undefined,
        }),
      });
      playBeep(880, 0.15);
      setEditRequestOpen(false);
      setEditRequestReason("");
      setEditRequestValue("");
      setEditRequestProduct(null);
      showToast("Edit request sent! Admin will review and approve.", "success");
    } catch (e: any) {
      showToast(e?.message ?? "Failed to send request", "error");
    } finally {
      setEditRequestBusy(false);
    }
  };

  // Add product state for employees
  const [addProductOpen, setAddProductOpen] = useState(false);
  const [newProduct, setNewProduct] = useState({
    name: "",
    barcode: "",
    category: "",
    basePrice: 0,
    costPrice: 0,
    stockQty: 0,
    taxRate: 0,
  });
  const [addProductBusy, setAddProductBusy] = useState(false);

  const handleAddProduct = async () => {
    if (!newProduct.name.trim()) {
      showToast("Product name is required", "warning");
      return;
    }
    setAddProductBusy(true);
    try {
      await api("/products", {
        method: "POST",
        body: JSON.stringify(newProduct),
      });
      playBeep(880, 0.15);
      setAddProductOpen(false);
      setNewProduct({ name: "", barcode: "", category: "", basePrice: 0, costPrice: 0, stockQty: 0, taxRate: 0 });
      qc.invalidateQueries({ queryKey: ["products"] });
      showToast("Product added successfully!", "success");
    } catch (e: any) {
      showToast(e?.message ?? "Failed to add product", "error");
    } finally {
      setAddProductBusy(false);
    }
  };

  // SELLER VIEW with bulk upload
  if (!canEdit) {
    return (
      <div className="space-y-4">
        {/* Edit Request Modal */}
        {editRequestOpen && editRequestProduct && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 shadow-xl">
              <h3 className="text-lg font-semibold text-[var(--fg)]">Request Edit</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Request an edit for: <strong>{editRequestProduct.name}</strong>
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs text-[var(--muted)]">Edit Type</label>
                  <select
                    value={editRequestType}
                    onChange={(e) => setEditRequestType(e.target.value as any)}
                    className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  >
                    <option value="stock_adjustment">Stock Adjustment</option>
                    <option value="price_change">Price Change</option>
                    <option value="product_edit">Edit Product Details</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                {editRequestType === "stock_adjustment" && (
                  <div>
                    <label className="text-xs text-[var(--muted)]">New Stock Quantity (current: {editRequestProduct.stock_qty})</label>
                    <input
                      type="number"
                      value={editRequestValue}
                      onChange={(e) => setEditRequestValue(e.target.value)}
                      placeholder="Enter new stock quantity"
                      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                    />
                  </div>
                )}
                {editRequestType === "price_change" && (
                  <div>
                    <label className="text-xs text-[var(--muted)]">New Price (current: {editRequestProduct.base_price})</label>
                    <input
                      type="number"
                      value={editRequestValue}
                      onChange={(e) => setEditRequestValue(e.target.value)}
                      placeholder="Enter new price"
                      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs text-[var(--muted)]">Reason (required)</label>
                  <textarea
                    value={editRequestReason}
                    onChange={(e) => setEditRequestReason(e.target.value)}
                    placeholder="Explain why this edit is needed..."
                    rows={3}
                    className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  />
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => {
                    setEditRequestOpen(false);
                    setEditRequestReason("");
                    setEditRequestValue("");
                  }}
                  className="rounded-md border border-[var(--stroke)] px-4 py-2 text-sm text-[var(--fg)]"
                >
                  Cancel
                </button>
                <button
                  onClick={submitEditRequest}
                  disabled={editRequestBusy || !editRequestReason.trim()}
                  className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {editRequestBusy ? "Sending..." : "Send Request"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Product Modal */}
        {addProductOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 shadow-xl max-h-[90vh] overflow-auto">
              <h3 className="text-lg font-semibold text-[var(--fg)]">Add New Product</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Product will be added but cannot be edited without admin approval.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs text-[var(--muted)]">Product Name *</label>
                  <input
                    type="text"
                    value={newProduct.name}
                    onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">Barcode</label>
                  <input
                    type="text"
                    value={newProduct.barcode}
                    onChange={(e) => setNewProduct({ ...newProduct, barcode: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">Category</label>
                  <input
                    type="text"
                    value={newProduct.category}
                    onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[var(--muted)]">Selling Price</label>
                    <input
                      type="number"
                      value={newProduct.basePrice}
                      onChange={(e) => setNewProduct({ ...newProduct, basePrice: Number(e.target.value) })}
                      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted)]">Stock Qty</label>
                    <input
                      type="number"
                      value={newProduct.stockQty}
                      onChange={(e) => setNewProduct({ ...newProduct, stockQty: Number(e.target.value) })}
                      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                    />
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setAddProductOpen(false)}
                  className="rounded-md border border-[var(--stroke)] px-4 py-2 text-sm text-[var(--fg)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddProduct}
                  disabled={addProductBusy || !newProduct.name.trim()}
                  className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {addProductBusy ? "Adding..." : "Add Product"}
                </button>
              </div>
            </div>
          </div>
        )}

        <PageHeading
          id="products"
          title="Inventory"
          subtitle="View stock levels, add products, and request edits."
        />

        {/* Tab switcher */}
        <div className="flex gap-2 border-b border-[var(--stroke)] pb-2">
          <button
            onClick={() => setBulkTab("view")}
            className={`px-4 py-2 text-sm font-semibold rounded-t-lg ${
              bulkTab === "view" ? "bg-teal-600 text-white" : "text-[var(--muted)]"
            }`}
          >
            View Inventory
          </button>
          <button
            onClick={() => setBulkTab("upload")}
            className={`px-4 py-2 text-sm font-semibold rounded-t-lg ${
              bulkTab === "upload" ? "bg-teal-600 text-white" : "text-[var(--muted)]"
            }`}
          >
            Bulk Stock Upload
          </button>
          <button
            onClick={() => setAddProductOpen(true)}
            className="ml-auto px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white"
          >
            + Add Product
          </button>
        </div>

        {bulkTab === "upload" && (
          <div className="space-y-4">
            {/* Upload instructions */}
            <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-[var(--fg)]">Bulk Stock Upload</h3>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Upload a CSV file with columns: <code className="bg-[var(--surface)] px-1 rounded">barcode,name,quantity,price</code>
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Products matched by barcode or name will have stock updated. Unmatched items can be added as new products after scanning their barcodes.
              </p>
              <div className="mt-4">
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleBulkFile}
                  className="text-sm text-[var(--fg)]"
                />
              </div>
            </div>

            {bulkPreview && (
              <>
                {/* Matched products */}
                <div className="rounded-2xl border border-teal-500/30 bg-[var(--card)] p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-teal-400">
                    Matched Products ({bulkPreview.matched.length})
                  </h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Stock will be added to these existing products.
                  </p>
                  {bulkPreview.matched.length > 0 ? (
                    <div className="mt-3 overflow-auto max-h-48">
                      <table className="min-w-full text-left text-sm">
                        <thead className="text-[var(--muted)] text-xs">
                          <tr>
                            <th className="px-2 py-1">Product</th>
                            <th className="px-2 py-1">Match</th>
                            <th className="px-2 py-1">Current</th>
                            <th className="px-2 py-1">Add</th>
                            <th className="px-2 py-1">New</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bulkPreview.matched.map((m, i) => (
                            <tr key={i} className="border-t border-[var(--stroke)]">
                              <td className="px-2 py-1 text-[var(--fg)]">{m.product.name}</td>
                              <td className="px-2 py-1">
                                <span className="text-xs text-teal-400">{m.matchedBy}</span>
                              </td>
                              <td className="px-2 py-1 text-[var(--muted)]">{m.product.stock_qty}</td>
                              <td className="px-2 py-1 text-teal-400">+{m.addQty}</td>
                              <td className="px-2 py-1 font-semibold text-[var(--fg)]">
                                {m.product.stock_qty + m.addQty}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-[var(--muted)]">No matches found.</p>
                  )}
                </div>

                {/* Pending products */}
                <div className="rounded-2xl border border-amber-500/30 bg-[var(--card)] p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-amber-400">
                        Pending - New Products ({pendingItems.filter((p) => p.status !== "added").length})
                      </h3>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        Scan barcodes for these items to add them as new products.
                      </p>
                    </div>
                    {pendingItems.filter((p) => p.status !== "added").length > 0 && (
                      <button
                        onClick={scannerActive ? stopScanner : startScanner}
                        className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                          scannerActive ? "bg-red-600 text-white" : "bg-teal-600 text-white"
                        }`}
                      >
                        {scannerActive ? "Stop Scanner" : "Start Scanner"}
                      </button>
                    )}
                  </div>

                  {scannerActive && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-[var(--stroke)]">
                      <video ref={videoRef} className="w-full max-h-40 object-cover" />
                      <p className="bg-[var(--surface)] px-3 py-2 text-xs text-center text-[var(--muted)]">
                        {selectedPending
                          ? `Scanning for: ${pendingItems.find((p) => p.id === selectedPending)?.name}`
                          : "Select a product below to scan its barcode"}
                      </p>
                    </div>
                  )}

                  {pendingItems.filter((p) => p.status !== "added").length > 0 && (
                    <div className="mt-3 overflow-auto max-h-48">
                      <table className="min-w-full text-left text-sm">
                        <thead className="text-[var(--muted)] text-xs">
                          <tr>
                            <th className="px-2 py-1">Name</th>
                            <th className="px-2 py-1">Barcode</th>
                            <th className="px-2 py-1">Qty</th>
                            <th className="px-2 py-1">Price</th>
                            <th className="px-2 py-1">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pendingItems
                            .filter((p) => p.status !== "added")
                            .map((p) => (
                              <tr
                                key={p.id}
                                className={`border-t border-[var(--stroke)] ${
                                  selectedPending === p.id ? "bg-teal-500/10" : ""
                                }`}
                              >
                                <td className="px-2 py-1 text-[var(--fg)]">{p.name}</td>
                                <td className="px-2 py-1">
                                  <input
                                    type="text"
                                    value={p.barcode}
                                    onChange={(e) =>
                                      setPendingItems((prev) =>
                                        prev.map((pp) =>
                                          pp.id === p.id ? { ...pp, barcode: e.target.value } : pp
                                        )
                                      )
                                    }
                                    placeholder="Scan or type..."
                                    className="w-28 rounded border border-[var(--stroke)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--fg)]"
                                  />
                                </td>
                                <td className="px-2 py-1 text-[var(--muted)]">{p.qty}</td>
                                <td className="px-2 py-1 text-[var(--muted)]">
                                  {p.price ? `${currency} ${p.price}` : "—"}
                                </td>
                                <td className="px-2 py-1">
                                  <button
                                    onClick={() => setSelectedPending(selectedPending === p.id ? null : p.id)}
                                    className={`rounded px-2 py-0.5 text-xs ${
                                      selectedPending === p.id
                                        ? "bg-teal-600 text-white"
                                        : "bg-[var(--surface)] border border-[var(--stroke)] text-[var(--fg)]"
                                    }`}
                                  >
                                    {selectedPending === p.id ? "Scanning..." : "Scan"}
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Execute button */}
                <div className="flex items-center gap-4">
                  <button
                    onClick={executeBulkUpload}
                    disabled={bulkUploading}
                    className="rounded-md bg-teal-600 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {bulkUploading ? "Processing..." : "Execute Bulk Import"}
                  </button>
                  {bulkResult && (
                    <div className="text-sm">
                      <span className="text-teal-400">{bulkResult.updated} updated</span>
                      {" • "}
                      <span className="text-blue-400">{bulkResult.added} added</span>
                      {bulkResult.failed > 0 && (
                        <>
                          {" • "}
                          <span className="text-red-400">{bulkResult.failed} failed</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {bulkTab === "view" && (
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-[var(--fg)]">All products</h3>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
              />
              <div className="flex items-center gap-1 text-xs text-[var(--muted)]">
                <button
                  onClick={() => setSortKey("name")}
                  className={`px-2 py-1 rounded ${sortKey === "name" ? "bg-teal-600 text-white" : ""}`}
                >
                  Name
                </button>
                <button
                  onClick={() => setSortKey("base")}
                  className={`px-2 py-1 rounded ${sortKey === "base" ? "bg-teal-600 text-white" : ""}`}
                >
                  Price
                </button>
                <button
                  onClick={() => setSortKey("stock")}
                  className={`px-2 py-1 rounded ${sortKey === "stock" ? "bg-teal-600 text-white" : ""}`}
                >
                  Stock
                </button>
                <button
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  className="px-2 py-1 rounded border border-[var(--stroke)]"
                >
                  {sortDir === "asc" ? "Asc" : "Desc"}
                </button>
              </div>
            </div>
          </div>
          <div className="mt-3 overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--muted)] border-b border-[var(--stroke)]">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Barcode</th>
                  <th className="px-3 py-2">Price ({currency})</th>
                  <th className="px-3 py-2">Stock</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const low = p.low_stock_alert && p.stock_qty <= p.low_stock_alert;
                  return (
                    <tr
                      key={p.id}
                      className={`border-t border-[var(--stroke)] ${low ? "bg-red-500/10" : ""}`}
                    >
                      <td className="px-3 py-2 text-[var(--fg)] font-medium">{p.name}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{(p as any).category ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--muted)] font-mono text-xs">{p.barcode ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--fg)]">{p.base_price.toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <span className={`font-semibold ${low ? "text-red-400" : "text-[var(--fg)]"}`}>
                          {p.stock_qty}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {low ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                            Low Stock
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/20 px-2 py-0.5 text-xs font-medium text-teal-400">
                            In Stock
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            setEditRequestProduct(p);
                            setEditRequestType("stock_adjustment");
                            setEditRequestValue("");
                            setEditRequestReason("");
                            setEditRequestOpen(true);
                          }}
                          className="rounded px-2 py-1 text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                        >
                          Request Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-sm text-[var(--muted)]" colSpan={6}>
                      {search ? "No products match your search." : "No products yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted)]">
            <span>{sorted.length} product{sorted.length !== 1 ? "s" : ""}</span>
            <span>
              {products.filter((p) => p.low_stock_alert && p.stock_qty <= p.low_stock_alert).length} low stock
            </span>
          </div>
        </div>
        )}
      </div>
    );
  }

  // ADMIN EDITABLE VIEW
  return (
    <>
      <PromptModal
        open={pinOpen}
        title="Admin PIN required"
        message="Enter Admin PIN to continue."
        value={pinVal}
        onChange={setPinVal}
        inputType="password"
        placeholder="Enter PIN"
        confirmText="Continue"
        onCancel={() => {
          setPinOpen(false);
          pinResolver.current?.(null);
          pinResolver.current = null;
        }}
        onConfirm={() => {
          setPinOpen(false);
          pinResolver.current?.(pinVal.trim() || null);
          pinResolver.current = null;
        }}
      />
      <div className="space-y-4">
      <PageHeading
        id="products"
        title="Products"
        subtitle="Manage stock, enforce base price, and scan-ready intake."
      />
      <ProductManager
        currency={currency}
        onSaved={() => {}}
        scannedCode={scannedCode}
        onScanConsumed={onScanConsumed}
      />
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-[var(--fg)]">All products</h3>
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-32 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            />
            <span>Bulk low-stock:</span>
            <input
              type="number"
              value={lowBulk}
              onChange={(e) => setLowBulk(Number(e.target.value))}
              className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
            />
            <button
              className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-[var(--fg)]"
              onClick={bulkUpdateLow}
            >
              Apply to all
            </button>
            <button onClick={() => setSortKey("name")}>Sort name</button>
            <button onClick={() => setSortKey("base")}>Sort price</button>
            <button onClick={() => setSortKey("stock")}>Sort stock</button>
            <button onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>
        <div className="mt-2 overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-2 py-1">Name</th>
                <th className="px-2 py-1">Category</th>
                <th className="px-2 py-1">Barcode</th>
                <th className="px-2 py-1">Base</th>
                <th className="px-2 py-1">Cost</th>
                <th className="px-2 py-1">Tax</th>
                <th className="px-2 py-1">Stock</th>
                <th className="px-2 py-1">Low alert</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1">Expiry</th>
                <th className="px-2 py-1">Save</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const low = p.low_stock_alert && p.stock_qty <= p.low_stock_alert;
                const draft = drafts[p.id] || {};
                const val = <T extends keyof Product>(key: T, fallback: Product[T]) =>
                  (draft[key] as any) ?? fallback;
                const expiry = (val("expiry_date", (p as any).expiry_date ?? null) as any) as
                  | number
                  | null;
                const expiryStr = expiry ? new Date(expiry).toISOString().slice(0, 10) : "";
                const expired = expiry ? Date.now() > expiry : false;
                return (
                  <tr key={p.id} className={`border-t border-[var(--stroke)] ${low ? "bg-red-500/10" : ""}`}>
                    <td className="px-2 py-1 text-[var(--fg)]">{p.name}</td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={val("category", (p as any).category ?? "") as any}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], category: e.target.value },
                          }))
                        }
                        className="w-28 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                        placeholder="Category"
                      />
                    </td>
                    <td className="px-2 py-1 text-[var(--muted)]">{p.barcode ?? "—"}</td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={val("base_price", p.base_price)}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], base_price: Number(e.target.value) },
                          }))
                        }
                        className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={val("cost_price", (p as any).cost_price ?? 0)}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], cost_price: Number(e.target.value) },
                          }))
                        }
                        className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={val("tax_rate", p.tax_rate)}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], tax_rate: Number(e.target.value) },
                          }))
                        }
                        className="w-16 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={val("stock_qty", p.stock_qty)}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], stock_qty: Number(e.target.value) },
                          }))
                        }
                        className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={val("low_stock_alert", p.low_stock_alert ?? 0)}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: { ...d[p.id], low_stock_alert: Number(e.target.value) },
                          }))
                        }
                        className="w-20 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)]"
                      />
                    </td>
                    <td className="px-2 py-1 text-[var(--muted)]">
                      {low ? (
                        <span className="text-red-400 font-medium">Low</span>
                      ) : ""}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="date"
                        value={expiryStr}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [p.id]: {
                              ...d[p.id],
                              expiry_date: e.target.value
                                ? new Date(`${e.target.value}T00:00:00`).getTime()
                                : null,
                            },
                          }))
                        }
                        className={`w-36 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-[var(--fg)] ${
                          expired ? "border-red-500/50" : ""
                        }`}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--fg)]"
                        onClick={() => updateProduct(p.id, drafts[p.id] || {})}
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td className="px-2 py-2 text-xs text-[var(--muted)]" colSpan={11}>
                    {search ? "No products match your search." : "No products yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </>
  );
};

const ServicesPage = ({
  currency,
  services,
  canEdit = false,
}: {
  currency: string;
  services: Service[];
  canEdit?: boolean;
}) => {
  const [sortKey, setSortKey] = useState<"name" | "price" | "tax">("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const sorted = useMemo(() => {
    const list = [...services];
    list.sort((a, b) => {
      const mult = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return mult * a.name.localeCompare(b.name);
      if (sortKey === "price")
        return mult * ((a.suggested_price ?? 0) - (b.suggested_price ?? 0));
      return mult * ((a.tax_rate ?? 0) - (b.tax_rate ?? 0));
    });
    return list;
  }, [services, sortKey, sortDir]);

  const baseTable = (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--fg)]">All services</h3>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <button onClick={() => setSortKey("name")}>Sort name</button>
          <button onClick={() => setSortKey("price")}>Sort price</button>
          <button onClick={() => setSortKey("tax")}>Sort tax</button>
          <button onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
            {sortDir === "asc" ? "Asc" : "Desc"}
          </button>
        </div>
      </div>
      <div className="mt-2 overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[var(--muted)]">
            <tr>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Category</th>
              <th className="px-2 py-1">Default Price</th>
              <th className="px-2 py-1">Tax</th>
              <th className="px-2 py-1">KPI</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id} className="border-t border-[var(--stroke)]">
                <td className="px-2 py-1 text-[var(--fg)]">{s.name}</td>
                <td className="px-2 py-1 text-[var(--muted)]">{(s as any).category ?? "—"}</td>
                <td className="px-2 py-1 text-[var(--muted)]">
                  {s.suggested_price ? `${currency} ${s.suggested_price}` : "Dynamic"}
                </td>
                <td className="px-2 py-1 text-[var(--muted)]">{s.tax_rate}</td>
                <td className="px-2 py-1 text-[var(--muted)]">{(s as any).kpiEligible ? "Yes" : "No"}</td>
              </tr>
            ))}
            {services.length === 0 && (
              <tr>
                <td className="px-2 py-2 text-xs text-[var(--muted)]" colSpan={5}>
                  No services yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (!canEdit) {
    return (
      <div className="space-y-4">
        <PageHeading
          id="services"
          title="Services"
          subtitle="View-only for employees. Contact Admin for edits."
        />
        {baseTable}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeading
        id="services"
        title="Services"
        subtitle="Dynamic pricing with KPI-eligible services."
      />
      <ServiceManager currency={currency} onSaved={() => {}} />
      {baseTable}
    </div>
  );
};

const SellPage = ({
  settings,
  branches,
  devices,
  sellers,
  products,
  services,
  branchId,
  deviceId,
  sellerId,
  onBranchChange,
  onDeviceChange,
  onSellerChange,
  scanValue,
  onScan,
  onScanConsumed,
  onGoProducts,
}: {
  settings: Setting;
  branches: Branch[];
  devices: Device[];
  sellers: Seller[];
  products: Product[];
  services: Service[];
  branchId: string;
  deviceId: string;
  sellerId: string;
  onBranchChange: (id: string) => void;
  onDeviceChange: (id: string) => void;
  onSellerChange: (id: string) => void;
  scanValue: string | null;
  onScan: (code: string | null) => void;
  onScanConsumed: () => void;
  onGoProducts: () => void;
}) => (
  <div className="space-y-4">
    <PageHeading
      id="sell"
      title="Sell"
      subtitle="Unified product and service selling with barcode and camera intake."
    />
    <div className="grid gap-4 lg:grid-cols-[1.4fr,1fr]">
      <SellScreen
        currency={settings.currency}
        settings={settings}
        branches={branches}
        devices={devices}
        sellers={sellers}
        products={products}
        services={services}
        onSale={() => {}}
        scannedCode={scanValue}
        onScanConsumed={onScanConsumed}
        onGoProducts={onGoProducts}
        branchId={branchId}
        deviceId={deviceId}
        sellerId={sellerId}
        onBranchChange={onBranchChange}
        onDeviceChange={onDeviceChange}
        onSellerChange={onSellerChange}
        businessName={settings.businessName}
        branchName={branches.find((b) => b.id === branchId)?.name ?? ""}
        sellerName={sellers.find((s) => s.id === sellerId)?.name ?? "Seller"}
      />
      <ScannerPanel
        onScan={(code) => onScan(code)}
        mobileLink={`${window.location.origin}/?view=mobile-scanner`}
      />
    </div>
  </div>
);

const MySalesPage = ({ currency }: { currency: string }) => {
  const { data, isLoading, isError, error, refetch } = useQuery<any[]>({
    queryKey: ["sales", "mine"],
    queryFn: () => api("/sales?limit=50"),
  });
  return (
    <div className="space-y-4">
      <PageHeading id="mysales" title="My sales" subtitle="Recent sales attributed to your PIN login." />
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Recent</h3>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--fg)]"
            onClick={() => refetch()}
            type="button"
          >
            Refresh
          </button>
        </div>
        {isLoading ? (
          <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
        ) : isError ? (
          <p className="mt-2 text-xs text-red-400">{(error as any)?.message ?? "Failed to load sales"}</p>
        ) : (
          <div className="mt-2 overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--muted)]">
                <tr>
                  <th className="px-2 py-1">Receipt</th>
                  <th className="px-2 py-1">When</th>
                  <th className="px-2 py-1">Total</th>
                  <th className="px-2 py-1">Payment</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((s) => (
                  <tr key={s.id} className="border-t border-[var(--stroke)]">
                    <td className="px-2 py-1 text-[var(--fg)]">#{s.receipt_no}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{new Date(s.created_at).toLocaleString()}</td>
                    <td className="px-2 py-1 text-[var(--fg)]">
                      {currency} {Number(s.total_amount ?? 0).toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-[var(--muted)]">{s.payment_method}</td>
                  </tr>
                ))}
                {(data ?? []).length === 0 && (
                  <tr>
                    <td className="px-2 py-2 text-xs text-[var(--muted)]" colSpan={4}>
                      No sales yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const EmployeesPage = ({
  sellers,
  kpi,
}: {
  sellers: Seller[];
  kpi: any[];
}) => {
  const pointsBySeller: Record<string, number> = {};
  kpi.forEach((row: any) => {
    if (row.seller_id) {
      pointsBySeller[row.seller_id] = Number(row.points ?? 0);
    }
  });
  return (
    <div className="space-y-4">
      <PageHeading
        id="employees"
        title="Employees"
        subtitle="Roles, KPI points, and performance."
      />
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-2 py-1">Name</th>
                <th className="px-2 py-1">Role</th>
                <th className="px-2 py-1">Active</th>
                <th className="px-2 py-1">Points</th>
              </tr>
            </thead>
            <tbody>
              {sellers.map((s) => (
                <tr key={s.id} className="border-t border-[var(--stroke)]">
                  <td className="px-2 py-1 text-[var(--fg)]">{s.name}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{s.role}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{s.active ? "Yes" : "No"}</td>
                  <td className="px-2 py-1 text-[var(--fg)]">{pointsBySeller[s.id] ?? 0}</td>
                </tr>
              ))}
              {sellers.length === 0 && (
                <tr>
                  <td className="px-2 py-2 text-xs text-[var(--muted)]" colSpan={4}>
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const AccountsPage = ({
  currency,
  branchId,
  branches,
}: {
  currency: string;
  branchId: string;
  branches: Branch[];
}) => {
  const [scopeBranch, setScopeBranch] = useState<string>(() => branchId || "all");
  useEffect(() => {
    if (branchId && scopeBranch === "all") return;
    if (branchId && !scopeBranch) setScopeBranch(branchId);
  }, [branchId]);

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1).getTime();
  const startOfWeekMon = (d: Date) => {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = (day + 6) % 7; // Monday=0
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    base.setDate(base.getDate() - diff);
    return base.getTime();
  };

  const now = Date.now();
  const todayStart = startOfDay(new Date());
  const weekStart = startOfWeekMon(new Date());
  const monthStart = startOfMonth(new Date());
  const yearStart = startOfYear(new Date());

  const mkSummaryKey = (label: string) => ["accounts", "summary", label, scopeBranch] as const;
  const summary = (start: number, end: number) =>
    api<{
      count: number;
      totalAmount: number;
      totalTax: number;
      totalExtraValue: number;
      byMethod: Record<string, { total_amount: number; count: number }>;
    }>(
      `/reports/sales-summary?start=${start}&end=${end}${
        scopeBranch !== "all" ? `&branchId=${encodeURIComponent(scopeBranch)}` : ""
      }`
    );

  const todayQ = useQuery({
    queryKey: mkSummaryKey("today"),
    queryFn: () => summary(todayStart, now),
  });
  const weekQ = useQuery({
    queryKey: mkSummaryKey("week"),
    queryFn: () => summary(weekStart, now),
  });
  const monthQ = useQuery({
    queryKey: mkSummaryKey("month"),
    queryFn: () => summary(monthStart, now),
  });
  const yearQ = useQuery({
    queryKey: mkSummaryKey("year"),
    queryFn: () => summary(yearStart, now),
  });

  const [range, setRange] = useState(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { start: `${yyyy}-${mm}-${dd}`, end: `${yyyy}-${mm}-${dd}` };
  });
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const dailyQ = useQuery({
    queryKey: ["accounts", "daily", scopeBranch],
    queryFn: () =>
      api<any[]>(
        `/reports/daily-accounts?${
          scopeBranch !== "all" ? `branchId=${encodeURIComponent(scopeBranch)}` : ""
        }`
      ),
  });

  const exportCsv = async () => {
    setExportErr(null);
    setExporting(true);
    try {
      const start = new Date(`${range.start}T00:00:00`).getTime();
      const end = new Date(`${range.end}T23:59:59`).getTime();
      const rows = await api<any[]>(
        `/reports/sales-export?start=${start}&end=${end}&limit=20000${
          scopeBranch !== "all" ? `&branchId=${encodeURIComponent(scopeBranch)}` : ""
        }`
      );
      if (!rows.length) throw new Error("No sales in selected range.");
      const headers = Object.keys(rows[0]);
      const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => String(r[h] ?? "")).join(","))].join(
        "\n"
      );
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sella-sales_${range.start}_to_${range.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setExportErr(e?.message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const formatMoney = (n: number) => `${currency} ${Number(n || 0).toFixed(2)}`;

  const SummaryCard = ({ title, data }: { title: string; data: any }) => (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{title}</p>
      <p className="mt-1 text-2xl font-semibold text-[var(--fg)]">{formatMoney(data?.totalAmount ?? 0)}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">Sales: {data?.count ?? 0}</p>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-[var(--muted)]">
        <div className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1">
          Cash: {formatMoney(data?.byMethod?.cash?.total_amount ?? 0)}
        </div>
        <div className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1">
          Till: {formatMoney(data?.byMethod?.till?.total_amount ?? 0)}
        </div>
        <div className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1">
          Bank: {formatMoney(data?.byMethod?.bank?.total_amount ?? 0)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeading id="accounts" title="Accounts" subtitle="Sales totals and export to CSV for Google Sheets." />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[240px]">
          <SelectField
            label="Branch scope"
            value={scopeBranch}
            onChange={setScopeBranch}
            options={[
              { value: "all", label: "All branches" },
              ...branches.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs font-medium text-[var(--muted)]">From</span>
            <input
              type="date"
              value={range.start}
              onChange={(e) => setRange((p) => ({ ...p, start: e.target.value }))}
              className="mt-1 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--muted)]">To</span>
            <input
              type="date"
              value={range.end}
              onChange={(e) => setRange((p) => ({ ...p, end: e.target.value }))}
              className="mt-1 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
            />
          </label>
          <button
            className="h-10 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
            onClick={exportCsv}
            disabled={exporting}
            type="button"
          >
            {exporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>
      {exportErr && <p className="text-sm text-red-400">{exportErr}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Today" data={todayQ.data} />
        <SummaryCard title="This week" data={weekQ.data} />
        <SummaryCard title="This month" data={monthQ.data} />
        <SummaryCard title="This year" data={yearQ.data} />
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Daily accounts</h3>
          <button
            className="rounded-md bg-teal-600 px-3 py-2 text-xs font-semibold text-white"
            onClick={() => {
              const rows = dailyQ.data ?? [];
              if (!rows.length) return;
              const headers = ["DATE", "CASH", "TILL", "BANK", "TOTAL", "PROFIT"];
              const csv = [
                headers.join(","),
                ...rows.map((r: any) =>
                  [
                    r.day,
                    Number(r.cash ?? 0).toFixed(2),
                    Number(r.till ?? 0).toFixed(2),
                    Number(r.bank ?? 0).toFixed(2),
                    Number(r.total ?? 0).toFixed(2),
                    Number(r.profit ?? 0).toFixed(2),
                  ].join(",")
                ),
              ].join("\n");
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `sella-daily-accounts.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            type="button"
          >
            Export daily CSV
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Columns: DATE, CASH, TILL, BANK, TOTAL, PROFIT (profit excludes taxes; services profit uses service cost price).
        </p>
        <div className="mt-3 overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-2 py-1">DATE</th>
                <th className="px-2 py-1">CASH</th>
                <th className="px-2 py-1">TILL</th>
                <th className="px-2 py-1">BANK</th>
                <th className="px-2 py-1">TOTAL</th>
                <th className="px-2 py-1">PROFIT</th>
              </tr>
            </thead>
            <tbody>
              {(dailyQ.data ?? []).map((r: any) => (
                <tr key={r.day} className="border-t border-[var(--stroke)]">
                  <td className="px-2 py-1 text-[var(--fg)]">{r.day}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{formatMoney(r.cash)}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{formatMoney(r.till)}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{formatMoney(r.bank)}</td>
                  <td className="px-2 py-1 text-[var(--fg)] font-semibold">{formatMoney(r.total)}</td>
                  <td className="px-2 py-1 text-emerald-400 font-semibold">{formatMoney(r.profit)}</td>
                </tr>
              ))}
              {(dailyQ.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-xs text-[var(--muted)]">
                    No sales yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Export downloads a `.csv` you can open directly in Excel or upload to Google Sheets.
      </p>
    </div>
  );
};

const ReturnsPage = ({
  currency,
  branchId,
  branches,
  sellerId,
  sellers,
}: {
  currency: string;
  branchId: string;
  branches: Branch[];
  sellerId: string;
  sellers: Seller[];
}) => {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    branchId: branchId || "",
    sellerId: sellerId || "",
    search: "",
    productId: "",
    quantity: 1,
    reason: "Customer return (restock)",
    restock: true,
  });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!form.branchId && branchId) setForm((p) => ({ ...p, branchId }));
    if (!form.sellerId && sellerId) setForm((p) => ({ ...p, sellerId }));
  }, [branchId, sellerId]);

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api("/products"),
  });

  const matches = useMemo(() => {
    const t = form.search.trim().toLowerCase();
    if (!t) return [];
    return products
      .filter((p) => p.name.toLowerCase().includes(t) || (p.barcode ?? "").toLowerCase().includes(t))
      .slice(0, 20);
  }, [products, form.search]);

  const activeProduct = useMemo(() => products.find((p) => p.id === form.productId) ?? null, [products, form.productId]);

  const returnsQ = useQuery<any[]>({
    queryKey: ["returns", form.branchId],
    queryFn: () =>
      api(`/returns?limit=200${form.branchId ? `&branchId=${encodeURIComponent(form.branchId)}` : ""}`),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form.branchId) throw new Error("Select branch");
      if (!form.sellerId) throw new Error("Select seller");
      if (!form.productId) throw new Error("Select product");
      if (!form.reason.trim()) throw new Error("Reason required");
      if (Number(form.quantity) <= 0) throw new Error("Quantity must be > 0");
      return api("/returns", {
        method: "POST",
        body: JSON.stringify({
          branchId: form.branchId,
          sellerId: form.sellerId,
          productId: form.productId,
          quantity: Number(form.quantity),
          reason: form.reason.trim(),
          restock: !!form.restock,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      setToast("Return saved.");
      setForm((p) => ({ ...p, search: "", productId: "", quantity: 1 }));
      setTimeout(() => setToast(null), 2000);
    },
  });

  return (
    <div className="space-y-4">
      <PageHeading id="returns" title="Returns" subtitle="Record returned goods and keep stock accurate." />
      {toast && <div className="rounded-lg border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-sm text-teal-200">{toast}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">New return</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Branch"
              value={form.branchId}
              onChange={(v) => setForm((p) => ({ ...p, branchId: v }))}
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
            />
            <SelectField
              label="Employee"
              value={form.sellerId}
              onChange={(v) => setForm((p) => ({ ...p, sellerId: v }))}
              options={sellers.map((s) => ({ value: s.id, label: s.name }))}
            />
            <div className="sm:col-span-2">
              <TextField
                label="Find product (name or barcode)"
                value={form.search}
                onChange={(v) => setForm((p) => ({ ...p, search: v }))}
              />
              {matches.length > 0 && (
                <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-[var(--stroke)] bg-[var(--surface)]">
                  {matches.map((p) => (
                    <button
                      key={p.id}
                      className="flex w-full items-center justify-between border-b border-[var(--stroke)] px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
                      onClick={() => setForm((s) => ({ ...s, productId: p.id, search: `${p.name}` }))}
                      type="button"
                    >
                      <span className="text-[var(--fg)]">{p.name}</span>
                      <span className="text-xs text-[var(--muted)]">{p.barcode ?? "—"} • Stock {p.stock_qty}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <NumberField
              label="Quantity returned"
              value={Number(form.quantity)}
              onChange={(v) => setForm((p) => ({ ...p, quantity: v }))}
            />
            <TextField
              label="Reason"
              value={form.reason}
              onChange={(v) => setForm((p) => ({ ...p, reason: v }))}
            />
            <label className="sm:col-span-2 mt-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
              <input
                type="checkbox"
                checked={form.restock}
                onChange={(e) => setForm((p) => ({ ...p, restock: e.target.checked }))}
              />
              Add back to stock (uncheck for defective/damaged/expired items)
            </label>
          </div>
          {activeProduct && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Selected: <span className="font-semibold text-[var(--fg)]">{activeProduct.name}</span> • Current stock{" "}
              <span className="font-semibold text-[var(--fg)]">{activeProduct.stock_qty}</span>
            </p>
          )}
          <button
            className="mt-3 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => mutation.mutate()}
            disabled={mutation.isLoading}
            type="button"
          >
            {mutation.isLoading ? "Saving..." : "Save return"}
          </button>
          {mutation.isError && (
            <p className="mt-2 text-sm text-red-400">{(mutation.error as any)?.message ?? "Return failed"}</p>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Recent returns</h3>
          <p className="mt-2 text-xs text-[var(--muted)]">Shows last 200 returns for the selected branch.</p>
          <div className="mt-3 overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--muted)]">
                <tr>
                  <th className="px-2 py-1">When</th>
                  <th className="px-2 py-1">Product</th>
                  <th className="px-2 py-1">Qty</th>
                  <th className="px-2 py-1">Restock</th>
                  <th className="px-2 py-1">Reason</th>
                  <th className="px-2 py-1">Employee</th>
                </tr>
              </thead>
              <tbody>
                {(returnsQ.data ?? []).map((r: any) => (
                  <tr key={r.id} className="border-t border-[var(--stroke)]">
                    <td className="px-2 py-1 text-[var(--muted)]">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-2 py-1 text-[var(--fg)]">{r.product_name}</td>
                    <td className="px-2 py-1 text-[var(--fg)]">{r.quantity}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{r.restock ? "Yes" : "No"}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{r.reason}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{r.seller_name}</td>
                  </tr>
                ))}
                {(returnsQ.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-3 text-xs text-[var(--muted)]">
                      No returns yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
        Stock math: if <span className="font-semibold">Restock</span> is enabled, stock increases by returned quantity; if disabled (defective),
        stock is unchanged.
      </div>
    </div>
  );
};

// ===== SALES EXPORT COMPONENT =====
const SalesExportCard = ({ currency, branches }: { currency: string; branches: Branch[] }) => {
  const [exportType, setExportType] = useState<"products" | "services">("products");
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<any[]>([]);

  const exportCsv = (rows: any[], name: string) => {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    // Escape commas and quotes in values
    const escapeValue = (v: any) => {
      const str = String(v ?? "");
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const csv = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => escapeValue(r[h])).join(",")),
    ].join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }); // BOM for Excel
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fetchAndExport = async () => {
    setLoading(true);
    try {
      let url = exportType === "products" ? "/reports/sales-export" : "/reports/service-sales-export";
      const params = new URLSearchParams();
      if (dateRange.start) params.set("start", String(new Date(dateRange.start).getTime()));
      if (dateRange.end) params.set("end", String(new Date(dateRange.end).setHours(23, 59, 59, 999)));
      if (branchFilter !== "all") params.set("branchId", branchFilter);
      if (params.toString()) url += "?" + params.toString();
      
      const result = await api<any>(url);
      if (result.data?.length > 0) {
        exportCsv(result.data, result.type);
        setPreview(result.data.slice(0, 5));
      } else {
        showToast("No data to export for selected period.", "warning");
      }
    } catch (e: any) {
      showToast(e?.message ?? "Export failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-[var(--fg)]">Sales Reports Export</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Export detailed sales data to CSV (offline, no internet required).
      </p>
      
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="text-xs text-[var(--muted)]">Report Type</label>
          <select
            value={exportType}
            onChange={(e) => setExportType(e.target.value as any)}
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          >
            <option value="products">Product Sales</option>
            <option value="services">Service Sales</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-[var(--muted)]">Start Date</label>
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange((p) => ({ ...p, start: e.target.value }))}
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          />
        </div>
        <div>
          <label className="text-xs text-[var(--muted)]">End Date</label>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange((p) => ({ ...p, end: e.target.value }))}
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          />
        </div>
        <div>
          <label className="text-xs text-[var(--muted)]">Branch</label>
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          >
            <option value="all">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>
      
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={fetchAndExport}
          disabled={loading}
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Exporting..." : "Export CSV"}
        </button>
        <button
          onClick={() => {
            setDateRange({ start: "", end: "" });
            setBranchFilter("all");
            setPreview([]);
          }}
          className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--fg)]"
        >
          Reset Filters
        </button>
      </div>

      {preview.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-[var(--fg)]">Preview (first 5 rows):</p>
          <div className="mt-1 max-h-32 overflow-auto rounded border border-[var(--stroke)] bg-[var(--surface)] p-2 text-xs text-[var(--muted)]">
            {preview.map((row, i) => (
              <div key={i} className="border-b border-[var(--stroke)] py-1 last:border-0">
                {row.product_name || row.service_type || "Item"} • Qty: {row.quantity} • {currency} {row.line_total || row.total}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-md border border-[var(--stroke)] bg-[var(--surface)] p-2 text-xs text-[var(--muted)]">
        <p><strong>CSV includes:</strong></p>
        {exportType === "products" ? (
          <p>Receipt #, Date, Time, Product Name, Barcode, Price, Qty, Total, Cashier, Branch, Payment Method</p>
        ) : (
          <p>Receipt #, Date, Time, Service Type, Description, Price, Qty, Total, Cashier, Branch</p>
        )}
      </div>
    </div>
  );
};

// ===== EXPENSES PAGE =====
const ExpensesPage = ({
  currency,
  branchId,
  branches,
  isAdmin,
  allowEmployeeExpenses,
}: {
  currency: string;
  branchId: string;
  branches: Branch[];
  isAdmin: boolean;
  allowEmployeeExpenses: boolean;
}) => {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    description: "",
    category: "",
    amount: 0,
    notes: "",
    branchId: branchId || "",
  });
  const [filterBranch, setFilterBranch] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "approved" | "pending">("all");
  const [dateRange, setDateRange] = useState({ start: "", end: "" });

  const expensesQ = useQuery<any[]>({
    queryKey: ["expenses", filterBranch, filterStatus],
    queryFn: () => {
      let url = `/expenses?status=${filterStatus}`;
      if (filterBranch !== "all") url += `&branchId=${encodeURIComponent(filterBranch)}`;
      if (dateRange.start) url += `&start=${new Date(dateRange.start).getTime()}`;
      if (dateRange.end) url += `&end=${new Date(dateRange.end).setHours(23, 59, 59, 999)}`;
      return api(url);
    },
    refetchInterval: 15000,
  });

  const summaryQ = useQuery<any>({
    queryKey: ["expenses-summary", filterBranch],
    queryFn: () => {
      let url = "/expenses/summary";
      if (filterBranch !== "all") url += `?branchId=${encodeURIComponent(filterBranch)}`;
      return api(url);
    },
  });

  const netProfitQ = useQuery<any>({
    queryKey: ["net-profit", filterBranch],
    queryFn: () => {
      let url = "/reports/net-profit";
      if (filterBranch !== "all") url += `?branchId=${encodeURIComponent(filterBranch)}`;
      return api(url);
    },
    enabled: isAdmin,
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!form.description.trim()) throw new Error("Description is required");
      if (form.amount <= 0) throw new Error("Amount must be greater than 0");
      return api("/expenses", {
        method: "POST",
        body: JSON.stringify({
          description: form.description.trim(),
          category: form.category.trim() || undefined,
          amount: form.amount,
          notes: form.notes.trim() || undefined,
          branchId: form.branchId || undefined,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      qc.invalidateQueries({ queryKey: ["net-profit"] });
      setForm({ description: "", category: "", amount: 0, notes: "", branchId: branchId });
      playBeep(880, 0.15);
      if (isAdmin) {
        showToast("Expense added successfully", "success");
      } else {
        showToast("Expense submitted for admin approval", "info");
      }
    },
    onError: (err: any) => {
      showToast(err?.message || "Failed to add expense", "error");
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api(`/expenses/${id}/approve`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      showToast("Expense approved", "success");
      qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      qc.invalidateQueries({ queryKey: ["net-profit"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => api(`/expenses/${id}/reject`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      showToast("Expense rejected", "warning");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      qc.invalidateQueries({ queryKey: ["net-profit"] });
      showToast("Expense deleted", "success");
    },
    onError: (err: any) => {
      showToast(err?.message || "Failed to delete expense", "error");
    },
  });

  const canEnterExpenses = isAdmin || allowEmployeeExpenses;

  if (!canEnterExpenses && !isAdmin) {
    return (
      <div className="space-y-4">
        <PageHeading id="expenses" title="Expenses" subtitle="You don't have permission to view expenses." />
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-8 text-center">
          <p className="text-[var(--muted)]">Employee expense entry is disabled by admin.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeading id="expenses" title="Expenses" subtitle="Track business expenses for net profit calculation." />
      
      {/* Net Profit Summary (Admin only) */}
      {isAdmin && netProfitQ.data && (
        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Total Sales</p>
            <p className="mt-1 text-2xl font-bold text-teal-400">
              {currency} {Number(netProfitQ.data.totalSales ?? 0).toLocaleString()}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Total Expenses</p>
            <p className="mt-1 text-2xl font-bold text-red-400">
              {currency} {Number(netProfitQ.data.totalExpenses ?? 0).toLocaleString()}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Net Profit</p>
            <p className={`mt-1 text-2xl font-bold ${netProfitQ.data.netProfit >= 0 ? "text-teal-400" : "text-red-400"}`}>
              {currency} {Number(netProfitQ.data.netProfit ?? 0).toLocaleString()}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Profit Margin</p>
            <p className={`mt-1 text-2xl font-bold ${Number(netProfitQ.data.profitMargin) >= 0 ? "text-teal-400" : "text-red-400"}`}>
              {netProfitQ.data.profitMargin}%
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Add Expense Form */}
        {canEnterExpenses && (
          <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-[var(--fg)]">Add Expense</h3>
            {!isAdmin && (
              <p className="mt-1 text-xs text-amber-400">Your expenses will require admin approval.</p>
            )}
            <div className="mt-3 grid gap-3">
              <TextField
                label="Description *"
                value={form.description}
                onChange={(v) => setForm((p) => ({ ...p, description: v }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Category"
                  value={form.category}
                  onChange={(v) => setForm((p) => ({ ...p, category: v }))}
                />
                <NumberField
                  label={`Amount (${currency}) *`}
                  value={form.amount}
                  onChange={(v) => setForm((p) => ({ ...p, amount: v }))}
                />
              </div>
              <SelectField
                label="Branch"
                value={form.branchId}
                onChange={(v) => setForm((p) => ({ ...p, branchId: v }))}
                options={[
                  { value: "", label: "-- Select Branch --" },
                  ...branches.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
              <label className="block">
                <span className="text-xs font-medium text-[var(--muted)]">Notes</span>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
                  rows={2}
                />
              </label>
              <button
                onClick={() => addMutation.mutate()}
                disabled={addMutation.isPending}
                className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {addMutation.isPending ? "Adding..." : "Add Expense"}
              </button>
              {addMutation.isError && (
                <p className="text-xs text-red-400">{(addMutation.error as any)?.message}</p>
              )}
            </div>
          </div>
        )}

        {/* Expense Summary */}
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Summary</h3>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[var(--muted)]">Total Approved Expenses:</span>
              <span className="font-semibold text-[var(--fg)]">
                {currency} {Number(summaryQ.data?.totalExpenses ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--muted)]">Count:</span>
              <span className="text-[var(--fg)]">{summaryQ.data?.count ?? 0}</span>
            </div>
            {summaryQ.data?.byCategory?.length > 0 && (
              <div className="mt-3 border-t border-[var(--stroke)] pt-3">
                <p className="text-xs font-medium text-[var(--muted)]">By Category:</p>
                {summaryQ.data.byCategory.map((cat: any) => (
                  <div key={cat.category || "uncategorized"} className="flex items-center justify-between text-sm">
                    <span className="text-[var(--muted)]">{cat.category || "Uncategorized"}:</span>
                    <span className="text-[var(--fg)]">{currency} {Number(cat.total).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters and Expense List */}
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Expenses List</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterBranch}
              onChange={(e) => setFilterBranch(e.target.value)}
              className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
            >
              <option value="all">All Branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {isAdmin && (
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
              >
                <option value="all">All Status</option>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            )}
          </div>
        </div>

        <div className="mt-3 overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)] border-b border-[var(--stroke)]">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">By</th>
                {isAdmin && <th className="px-3 py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {(expensesQ.data ?? []).map((exp: any) => (
                <tr key={exp.id} className="border-t border-[var(--stroke)]">
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {new Date(exp.expense_date).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-[var(--fg)]">{exp.description}</td>
                  <td className="px-3 py-2 text-[var(--muted)]">{exp.category || "—"}</td>
                  <td className="px-3 py-2 text-[var(--fg)] font-medium">
                    {currency} {Number(exp.amount).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      exp.approved ? "bg-teal-500/20 text-teal-400" : "bg-amber-500/20 text-amber-400"
                    }`}>
                      {exp.approved ? "Approved" : "Pending"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">{exp.created_by_name}</td>
                  {isAdmin && (
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        {!exp.approved && (
                          <>
                            <button
                              onClick={() => approveMutation.mutate(exp.id)}
                              className="rounded px-2 py-1 text-xs bg-teal-600 text-white"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => rejectMutation.mutate(exp.id)}
                              className="rounded px-2 py-1 text-xs bg-red-600 text-white"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            if (confirm("Delete this expense?")) deleteMutation.mutate(exp.id);
                          }}
                          className="rounded px-2 py-1 text-xs border border-red-500 text-red-400"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {(expensesQ.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="px-3 py-8 text-center text-[var(--muted)]">
                    No expenses found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const ReportsPage = ({
  currency,
  kpi,
  branches,
  products,
  services,
}: {
  currency: string;
  kpi: any[];
  branches: Branch[];
  products: Product[];
  services: Service[];
}) => {
  const [rules, setRules] = useState<
    { threshold: number; points: number }[]
  >(() => {
    const saved = localStorage.getItem("kpi-rules");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });
  const [ruleInput, setRuleInput] = useState({ threshold: 50, points: 2 });
  const [search, setSearch] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [pinVal, setPinVal] = useState("");
  const pinResolver = useRef<((v: string | null) => void) | null>(null);
  const hashPin = async (val: string) => {
    const enc = new TextEncoder().encode(val);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const requireAdminPin = useCallback(async () => {
    const stored = localStorage.getItem("admin-pin-hash");
    if (!stored) return true;
    const pin = await new Promise<string | null>((resolve) => {
      pinResolver.current = resolve;
      setPinVal("");
      setPinOpen(true);
    });
    if (!pin) return false;
    const attempt = await hashPin(pin);
    if (attempt !== stored) {
      showToast("Invalid PIN", "error");
      return false;
    }
    return true;
  }, []);
  const addAudit = useCallback((entry: string) => {
    const log = JSON.parse(localStorage.getItem("audit-log") || "[]") as string[];
    log.unshift(`${new Date().toLocaleString()} • ${entry}`);
    localStorage.setItem("audit-log", JSON.stringify(log.slice(0, 200)));
  }, []);
  const exportCsv = (rows: any[], name: string) => {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => r[h]).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const addRule = async () => {
    if (!(await requireAdminPin())) return;
    const next = [...rules, { threshold: ruleInput.threshold, points: ruleInput.points }].sort(
      (a, b) => a.threshold - b.threshold
    );
    setRules(next);
    localStorage.setItem("kpi-rules", JSON.stringify(next));
    addAudit(`KPI rule added: extra >= ${ruleInput.threshold} -> ${ruleInput.points} pts`);
  };

  const removeRule = async (idx: number) => {
    if (!(await requireAdminPin())) return;
    const next = rules.filter((_, i) => i !== idx);
    setRules(next);
    localStorage.setItem("kpi-rules", JSON.stringify(next));
    addAudit(`KPI rule removed`);
  };

  const previewPoints = (extraValue: number) => {
    let earned = 0;
    rules.forEach((r) => {
      if (extraValue >= r.threshold) earned = Math.max(earned, r.points);
    });
    return earned;
  };

  const topEmployees = useMemo(() => {
    const map = new Map<string, number>();
    kpi.forEach((row: any) => {
      if (row.seller_name) {
        map.set(row.seller_name, (map.get(row.seller_name) ?? 0) + (row.points ?? 0));
      }
    });
    return Array.from(map.entries())
      .map(([name, pts]) => ({ name, pts }))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, 5);
  }, [kpi]);

  const inventoryFiltered = useMemo(() => {
    if (!search) return products;
    const term = search.toLowerCase();
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.barcode ?? "").toLowerCase().includes(term)
    );
  }, [products, search]);

  const salesSplit = [
    { label: "Products", value: products.length },
    { label: "Services", value: services.length },
  ];

  const ChartBar = ({ label, value, max }: { label: string; value: number; max: number }) => (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-[var(--muted)]">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface)]">
        <div
          className="h-full bg-teal-600"
          style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }}
        />
      </div>
    </div>
  );

  return (
    <>
      <PromptModal
        open={pinOpen}
        title="Admin PIN required"
        message="Enter Admin PIN to edit KPI rules and exports."
        value={pinVal}
        onChange={setPinVal}
        inputType="password"
        placeholder="Enter PIN"
        confirmText="Continue"
        onCancel={() => {
          setPinOpen(false);
          pinResolver.current?.(null);
          pinResolver.current = null;
        }}
        onConfirm={() => {
          setPinOpen(false);
          pinResolver.current?.(pinVal.trim() || null);
          pinResolver.current = null;
        }}
      />
      <div className="space-y-4">
      <PageHeading
        id="reports"
        title="Reports"
        subtitle="Sortable summaries for sales, inventory, and KPI."
      />
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-[var(--fg)]">At a glance</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ChartBar
            label="Products"
            value={products.length}
            max={Math.max(products.length, services.length, 1)}
          />
          <ChartBar
            label="Services"
            value={services.length}
            max={Math.max(products.length, services.length, 1)}
          />
          <ChartBar
            label="Branches"
            value={branches.length}
            max={Math.max(branches.length, 1)}
          />
        </div>
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold text-[var(--fg)]">Top employees (points)</p>
          {topEmployees.length === 0 && (
            <p className="text-xs text-[var(--muted)]">No KPI data yet.</p>
          )}
          {topEmployees.map((e) => (
            <ChartBar
              key={e.name}
              label={e.name}
              value={e.pts}
              max={topEmployees[0]?.pts || 1}
            />
          ))}
        </div>
      </div>
      <KpiBoard currency={currency} data={kpi ?? []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">KPI rules</h3>
          <div className="mt-2 flex gap-2 text-xs text-[var(--muted)]">
            <NumberField
              label="Extra value ≥"
              value={ruleInput.threshold}
              onChange={(v) => setRuleInput((p) => ({ ...p, threshold: v }))}
            />
            <NumberField
              label="Points"
              value={ruleInput.points}
              onChange={(v) => setRuleInput((p) => ({ ...p, points: v }))}
            />
            <button
              className="self-end rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--fg)]"
              onClick={addRule}
            >
              Add rule
            </button>
          </div>
          <div className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {rules.map((r, idx) => (
              <div
                key={`${r.threshold}-${idx}`}
                className="flex items-center justify-between rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1"
              >
                <span>
                  Extra ≥ {currency} {r.threshold} → {r.points} pts
                </span>
                <button
                  className="text-red-400"
                  onClick={() => removeRule(idx)}
                >
                  Remove
                </button>
              </div>
            ))}
            {rules.length === 0 && <p>No KPI rules set.</p>}
          </div>
          <div className="mt-2 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
            <p className="font-semibold text-[var(--fg)]">Preview</p>
            <p>Extra 50 → {previewPoints(50)} pts</p>
            <p>Extra 100 → {previewPoints(100)} pts</p>
            <p>Extra 200 → {previewPoints(200)} pts</p>
          </div>
        </div>

        <SalesExportCard currency={currency} branches={branches} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Inventory snapshot</h3>
          <p className="mt-2 text-xs text-[var(--muted)]">Products: {products.length}</p>
          <p className="text-xs text-[var(--muted)]">Services: {services.length}</p>
          <p className="mt-3 text-xs font-semibold text-[var(--fg)]">Search products</p>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or barcode"
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          />
          <div className="mt-2 max-h-40 overflow-auto text-xs text-[var(--muted)]">
            {inventoryFiltered.map((p) => (
              <div key={p.id} className="border-b border-[var(--stroke)] py-1">
                {p.name} • {p.barcode ?? "—"} • {currency} {p.base_price} • Stock {p.stock_qty}
              </div>
            ))}
            {inventoryFiltered.length === 0 && <p>No products match.</p>}
          </div>
        </div>
        <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Branches</h3>
          <p className="mt-2 text-xs text-[var(--muted)]">Active branches: {branches.length}</p>
          <p className="text-xs text-[var(--muted)]">(Placeholder) Sync health per branch/device.</p>
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {branches.map((b) => (
              <li key={b.id} className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1">
                {b.name} • {b.currency} • Tax {b.tax_rate ?? "-"}
              </li>
            ))}
          </ul>
        </div>
      </div>
      </div>
    </>
  );
};

const AdminPage = ({
  settings,
  branches,
  devices,
  sellers,
  kpi,
  offlineQueue,
  lastSync,
  onSyncNow,
}: {
  settings: Setting;
  branches: Branch[];
  devices: Device[];
  sellers: Seller[];
  kpi: any[];
  offlineQueue: number;
  lastSync: string;
  onSyncNow: () => void;
}) => {
  const qc = useQueryClient();
  const [backupStatus, setBackupStatus] = useState<string>(() => localStorage.getItem("last-backup") || "Never");
  const [backupErr, setBackupErr] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [empForm, setEmpForm] = useState({ name: "", role: "seller" as Role, pin: "", active: true });
  const [empErr, setEmpErr] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetVal, setResetVal] = useState("");
  const [resetErr, setResetErr] = useState<string | null>(null);
  const [pinResetOpen, setPinResetOpen] = useState(false);
  const [pinResetVal, setPinResetVal] = useState("");
  const [pinResetErr, setPinResetErr] = useState<string | null>(null);
  const [pinResetSeller, setPinResetSeller] = useState<Seller | null>(null);
  const [sheetUrl, setSheetUrl] = useState<string>(settings.googleSheetUrl || "");
  const [sheetMsg, setSheetMsg] = useState<string | null>(null);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [autoSync, setAutoSync] = useState<boolean>(() => localStorage.getItem("auto-sync-enabled") === "true");
  const [lowStockSound, setLowStockSound] = useState<boolean>(settings.lowStockSoundEnabled !== false);

  const toggleAutoSync = () => {
    const next = !autoSync;
    setAutoSync(next);
    localStorage.setItem("auto-sync-enabled", String(next));
  };

  const toggleLowStockSound = async () => {
    const next = !lowStockSound;
    setLowStockSound(next);
    try {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ lowStockSoundEnabled: next }),
      });
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch {
      // Revert on error
      setLowStockSound(!next);
    }
  };

  const sheetsQueue = useQuery<any[]>({
    queryKey: ["sheets-queue"],
    queryFn: () => api("/sync/sheets/queue"),
    refetchInterval: 15000,
  });

  // Edit requests for notifications
  const editRequests = useQuery<any[]>({
    queryKey: ["edit-requests"],
    queryFn: () => api("/edit-requests?status=all"),
    refetchInterval: 10000,
  });

  const pendingRequests = (editRequests.data ?? []).filter((r: any) => r.status === "pending");
  const [notifOpen, setNotifOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [completeValue, setCompleteValue] = useState("");

  const approveRequest = async (id: string) => {
    try {
      await api(`/edit-requests/${id}/approve`, { method: "POST", body: JSON.stringify({}) });
      editRequests.refetch();
      playBeep(880, 0.15);
      showToast("Request approved successfully", "success");
    } catch (e: any) {
      showToast(e?.message ?? "Failed to approve request", "error");
    }
  };

  const rejectRequest = async (id: string) => {
    try {
      await api(`/edit-requests/${id}/reject`, { method: "POST", body: JSON.stringify({}) });
      editRequests.refetch();
      playBeep(660, 0.2);
      showToast("Request rejected", "warning");
    } catch (e: any) {
      showToast(e?.message ?? "Failed to reject request", "error");
    }
  };

  const completeRequest = async (req: any) => {
    try {
      const body: any = {};
      if (req.request_type === "stock_adjustment") body.newStockQty = Number(completeValue);
      if (req.request_type === "price_change") body.newBasePrice = Number(completeValue);
      if (req.request_type === "product_edit") body.newName = completeValue;

      await api(`/edit-requests/${req.id}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      editRequests.refetch();
      qc.invalidateQueries({ queryKey: ["products"] });
      playBeep(880, 0.15);
      setSelectedRequest(null);
      setCompleteValue("");
    } catch (e: any) {
      showToast(e?.message ?? "Failed to complete edit", "error");
    }
  };

  const runBackup = async () => {
    setBackupErr(null);
    setBackupBusy(true);
    try {
      const destDir = String(settings.backupPath ?? "").trim();
      if (!destDir) throw new Error("Backup folder path is empty. Set it in Setup.");
      const api = (window as any).api;
      if (!api?.backupDb) throw new Error("Backup feature not available (preload not loaded).");
      const result = (await api.backupDb(destDir)) as { destFile: string; size: number; when: string };
      const msg = `${new Date(result.when).toLocaleString()} • ${result.destFile} • ${(result.size / 1024 / 1024).toFixed(1)} MB`;
      localStorage.setItem("last-backup", msg);
      setBackupStatus(msg);
    } catch (e: any) {
      setBackupErr(e?.message ?? "Backup failed");
    } finally {
      setBackupBusy(false);
    }
  };

  const saveSheetUrl = async () => {
    setSheetErr(null);
    setSheetMsg(null);
    try {
      if (!sheetUrl.trim()) throw new Error("Enter the Google Sheet link");
      await api("/settings/google-sheet-url", {
        method: "POST",
        body: JSON.stringify({ url: sheetUrl.trim() }),
      });
      setSheetMsg("Saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e: any) {
      setSheetErr(e?.message ?? "Failed to save");
    }
  };

  const pushSheets = async () => {
    setSheetErr(null);
    setSheetMsg(null);
    if (!sheetUrl.trim()) {
      setSheetErr("Set a Google Sheet URL first");
      showToast("Set a Google Sheet URL first", "warning");
      return;
    }
    setSheetBusy(true);
    try {
      const result = await api<{ status: string; error?: string; message?: string }>("/sync/sheets/push", { method: "POST", body: JSON.stringify({}) });
      if (result.status === "success") {
        setSheetMsg(result.message || "Data sent to Google Sheets!");
      } else if (result.status === "pending") {
        setSheetMsg("Queued for retry - check connection");
      } else {
        setSheetErr(result.error || "Push failed");
      }
      sheetsQueue.refetch();
    } catch (e: any) {
      setSheetErr(e?.message ?? "Push failed");
    } finally {
      setSheetBusy(false);
    }
  };

  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  // Fetch sync status
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => api<{ trackers: any[]; totals: any }>("/sync/status"),
  });

  const copyDataToClipboard = async () => {
    setCopyBusy(true);
    setCopyMsg(null);
    setSheetErr(null);
    try {
      const data = await api<any>("/sync/export-data");
      const totalNew = Object.values(data.newRecords || {}).reduce((a: number, b: any) => a + (b || 0), 0);
      if (totalNew === 0) {
        showToast("No new data to copy. All data has been synced.", "info");
        setCopyMsg("No new data to copy. All data has been synced.");
        return;
      }
      const jsonStr = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      // Mark as synced after copying
      await api("/sync/mark-synced", { method: "POST", body: JSON.stringify({}) });
      syncStatus.refetch();
      const summary = Object.entries(data.newRecords || {})
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      setCopyMsg(`Copied ${totalNew} new records (${summary}). Marked as synced.`);
      showToast(`Copied ${totalNew} records to clipboard!`, "success");
    } catch (e: any) {
      setSheetErr(e?.message ?? "Failed to copy data");
      showToast(e?.message ?? "Failed to copy data", "error");
    } finally {
      setCopyBusy(false);
    }
  };

  const copyAllData = async () => {
    setCopyBusy(true);
    setCopyMsg(null);
    setSheetErr(null);
    try {
      const data = await api<any>("/sync/export-all");
      const jsonStr = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      setCopyMsg("ALL data copied (full export). This does NOT mark as synced.");
      showToast("All data copied to clipboard!", "success");
    } catch (e: any) {
      setSheetErr(e?.message ?? "Failed to copy data");
      showToast(e?.message ?? "Failed to copy data", "error");
    } finally {
      setCopyBusy(false);
    }
  };

  const resetSyncTracker = async () => {
    try {
      await api("/sync/reset-tracker", { method: "POST", body: JSON.stringify({}) });
      syncStatus.refetch();
      setCopyMsg("Sync tracker reset. Next copy will include all data.");
      showToast("Sync tracker reset successfully", "success");
    } catch (e: any) {
      setSheetErr(e?.message ?? "Failed to reset tracker");
      showToast(e?.message ?? "Failed to reset tracker", "error");
    }
  };

  return (
    <>
      <PromptModal
        open={resetOpen}
        title="Start fresh (Reset DB)"
        message="This deletes current DB data and restarts the local API. Type RESET to confirm."
        value={resetVal}
        onChange={(v) => {
          setResetVal(v);
          setResetErr(null);
        }}
        placeholder="Type RESET"
        confirmText="Delete & restart"
        cancelText="Cancel"
        error={resetErr ?? undefined}
        onCancel={() => {
          setResetOpen(false);
          setResetVal("");
          setResetErr(null);
        }}
        onConfirm={async () => {
          try {
            const ok = resetVal.trim();
            if (ok !== "RESET") {
              setResetErr('Please type "RESET" to confirm.');
              return;
            }
            const api = (window as any).api;
            await api?.resetDb?.();
            localStorage.clear();
            window.location.reload();
          } catch (e: any) {
            setResetErr(e?.message ?? "Reset failed");
          }
        }}
      />
      <PromptModal
        open={pinResetOpen}
        title="Reset employee PIN"
        message={pinResetSeller ? `Set new 4-digit PIN for ${pinResetSeller.name}` : "Set new 4-digit PIN"}
        value={pinResetVal}
        onChange={(v) => {
          setPinResetVal(v);
          setPinResetErr(null);
        }}
        inputType="password"
        placeholder="4 digits"
        confirmText="Save PIN"
        cancelText="Cancel"
        error={pinResetErr ?? undefined}
        onCancel={() => {
          setPinResetOpen(false);
          setPinResetVal("");
          setPinResetErr(null);
          setPinResetSeller(null);
        }}
        onConfirm={async () => {
          try {
            if (!pinResetSeller) return;
            const pin = pinResetVal.trim();
            if (!/^[0-9]{4}$/.test(pin)) {
              setPinResetErr("PIN must be exactly 4 digits");
              return;
            }
            await api(`/sellers/${pinResetSeller.id}`, { method: "PUT", body: JSON.stringify({ pin }) });
            qc.invalidateQueries({ queryKey: ["sellers"] });
            setPinResetOpen(false);
            setPinResetVal("");
            setPinResetErr(null);
            setPinResetSeller(null);
          } catch (e: any) {
            setPinResetErr(e?.message ?? "Failed to reset PIN");
          }
        }}
      />
      <div className="space-y-4">
    {/* Edit Request Detail Modal */}
    {selectedRequest && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-6 shadow-xl">
          <h3 className="text-lg font-semibold text-[var(--fg)]">Complete Edit Request</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Product: <strong>{selectedRequest.product_name}</strong>
          </p>
          <p className="text-sm text-[var(--muted)]">
            Type: <span className="capitalize">{selectedRequest.request_type.replace("_", " ")}</span>
          </p>
          <p className="text-sm text-[var(--muted)]">
            Reason: <em>{selectedRequest.reason}</em>
          </p>
          {selectedRequest.requested_value && (
            <p className="text-sm text-amber-400">
              Requested: {selectedRequest.current_value} → {selectedRequest.requested_value}
            </p>
          )}
          <div className="mt-4">
            <label className="text-xs text-[var(--muted)]">
              {selectedRequest.request_type === "stock_adjustment" ? "New Stock Quantity" :
               selectedRequest.request_type === "price_change" ? "New Price" : "New Value"}
            </label>
            <input
              type={selectedRequest.request_type === "product_edit" ? "text" : "number"}
              value={completeValue}
              onChange={(e) => setCompleteValue(e.target.value)}
              placeholder={selectedRequest.requested_value || "Enter new value"}
              className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
            />
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => {
                setSelectedRequest(null);
                setCompleteValue("");
              }}
              className="rounded-md border border-[var(--stroke)] px-4 py-2 text-sm text-[var(--fg)]"
            >
              Cancel
            </button>
            <button
              onClick={() => completeRequest(selectedRequest)}
              disabled={!completeValue}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Apply Edit
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Notifications Panel */}
    {notifOpen && (
      <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setNotifOpen(false)}>
        <div
          className="h-full w-full max-w-md bg-[var(--card)] border-l border-[var(--stroke)] shadow-xl overflow-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sticky top-0 bg-[var(--card)] border-b border-[var(--stroke)] p-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--fg)]">Edit Requests</h3>
            <button onClick={() => setNotifOpen(false)} className="text-[var(--muted)] text-xl">&times;</button>
          </div>
          <div className="p-4 space-y-3">
            {pendingRequests.length === 0 && (
              <p className="text-sm text-[var(--muted)] text-center py-8">No pending edit requests.</p>
            )}
            {(editRequests.data ?? []).map((req: any) => (
              <div
                key={req.id}
                className={`rounded-lg border p-4 ${
                  req.status === "pending" ? "border-amber-500/50 bg-amber-500/10" :
                  req.status === "approved" ? "border-teal-500/50 bg-teal-500/10" :
                  req.status === "completed" ? "border-blue-500/50 bg-blue-500/10" :
                  "border-red-500/50 bg-red-500/10"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-[var(--fg)]">{req.product_name}</p>
                    <p className="text-xs text-[var(--muted)]">
                      By: {req.requester_name} • {new Date(req.created_at).toLocaleString()}
                    </p>
                    <p className="text-xs mt-1 capitalize text-amber-400">
                      {req.request_type.replace("_", " ")}
                    </p>
                    <p className="text-sm mt-1 text-[var(--fg)]">{req.reason}</p>
                    {req.requested_value && (
                      <p className="text-xs text-[var(--muted)]">
                        Suggested: {req.current_value} → {req.requested_value}
                      </p>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    req.status === "pending" ? "bg-amber-500/30 text-amber-400" :
                    req.status === "approved" ? "bg-teal-500/30 text-teal-400" :
                    req.status === "completed" ? "bg-blue-500/30 text-blue-400" :
                    "bg-red-500/30 text-red-400"
                  }`}>
                    {req.status}
                  </span>
                </div>
                {req.status === "pending" && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => approveRequest(req.id)}
                      className="flex-1 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => rejectRequest(req.id)}
                      className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {req.status === "approved" && (
                  <div className="mt-3">
                    <button
                      onClick={() => {
                        setSelectedRequest(req);
                        setCompleteValue(req.requested_value || "");
                      }}
                      className="w-full rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Apply Edit Now
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}

    <div className="flex items-center justify-between mb-4">
      <PageHeading
        id="admin"
        title="Admin"
        subtitle="Sync, devices, and configuration (offline-first)."
      />
      <button
        onClick={() => setNotifOpen(true)}
        className="relative rounded-full p-2 bg-[var(--surface)] border border-[var(--stroke)]"
      >
        <svg className="w-6 h-6 text-[var(--fg)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {pendingRequests.length > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
            {pendingRequests.length}
          </span>
        )}
      </button>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Sync & Devices</h3>
        <p className="mt-2 text-xs text-[var(--muted)]">
          LAN/BroadcastChannel sync placeholders. Devices: {devices.length}. Branches: {branches.length}.
        </p>
        <p className="text-xs text-[var(--muted)]">Pending ops: {offlineQueue}</p>
        <p className="text-xs text-[var(--muted)]">Last sync: {lastSync}</p>
        <button
          className="mt-2 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--fg)]"
          onClick={onSyncNow}
        >
          Sync now
        </button>
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm lg:col-span-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Google Sheets Sync</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Copy new data to clipboard and paste into Google Sheets. Only NEW records since last sync are copied (no duplicates).
        </p>

        {/* Sync Status */}
        {syncStatus.data && (
          <div className="mt-3 rounded-lg border border-[var(--stroke)] bg-[var(--surface)] p-3">
            <p className="text-xs font-semibold text-[var(--fg)] mb-2">Sync Status:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {syncStatus.data.trackers.map((t: any) => {
                const total = syncStatus.data.totals[t.data_type] ?? 0;
                const synced = t.record_count ?? 0;
                const pending = Math.max(0, total - synced);
                return (
                  <div key={t.data_type} className="rounded bg-[var(--card)] p-2">
                    <p className="font-medium text-[var(--fg)] capitalize">{t.data_type.replace("_", " ")}</p>
                    <p className="text-[var(--muted)]">
                      Synced: <span className="text-emerald-500">{synced}</span>
                      {pending > 0 && <span className="text-amber-400 ml-1">({pending} new)</span>}
                    </p>
                    {t.last_synced_date && (
                      <p className="text-[10px] text-[var(--muted)]">Last: {t.last_synced_date}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            onClick={copyDataToClipboard}
            disabled={copyBusy}
            type="button"
          >
            {copyBusy ? "Copying..." : "Copy NEW Data"}
          </button>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--fg)] disabled:opacity-50"
            onClick={copyAllData}
            disabled={copyBusy}
            type="button"
          >
            Copy ALL Data
          </button>
          <button
            className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400"
            onClick={resetSyncTracker}
            type="button"
          >
            Reset Tracker
          </button>
        </div>

        {/* Optional: Google Apps Script URL */}
        <div className="mt-4 border-t border-[var(--stroke)] pt-3">
          <p className="text-xs text-[var(--muted)] mb-2">Optional: Auto-send to Google Apps Script URL</p>
          <TextField
            label="Google Apps Script URL"
            value={sheetUrl}
            onChange={setSheetUrl}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--fg)]"
              onClick={saveSheetUrl}
              type="button"
            >
              Save URL
            </button>
            <button
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              onClick={pushSheets}
              disabled={sheetBusy || !sheetUrl.trim()}
              type="button"
            >
              {sheetBusy ? "Sending..." : "Send to Sheets"}
            </button>
            <label className="flex items-center gap-2 text-xs text-[var(--fg)]">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={toggleAutoSync}
                className="h-4 w-4 rounded border-[var(--stroke)] accent-teal-600"
              />
              Auto-sync
            </label>
          </div>
        </div>

        {sheetMsg && <p className="mt-2 text-xs text-emerald-500">{sheetMsg}</p>}
        {copyMsg && <p className="mt-2 text-xs text-blue-400">{copyMsg}</p>}
        {sheetErr && <p className="mt-2 text-xs text-red-400">{sheetErr}</p>}

        <div className="mt-3">
          <p className="text-xs text-[var(--muted)]">Sync Queue (recent):</p>
          <div className="mt-1 max-h-32 overflow-auto rounded border border-[var(--stroke)] bg-[var(--surface)] text-xs text-[var(--fg)]">
            {(sheetsQueue.data ?? []).length === 0 && (
              <p className="p-2 text-[var(--muted)]">No queue entries yet.</p>
            )}
            {(sheetsQueue.data ?? []).map((row: any) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--stroke)] px-2 py-1 last:border-b-0">
                <span className={
                  row.status === "success" ? "text-emerald-500" :
                  row.status === "failed" ? "text-red-400" :
                  row.status === "retrying" ? "text-amber-400" :
                  "text-[var(--fg)]"
                }>
                  #{row.id} • {row.status}
                  {row.attempt_count > 0 && ` (attempt ${row.attempt_count})`}
                </span>
                <span className="text-[var(--muted)]">
                  {new Date(row.updated_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-[var(--fg)]">KPI rules & Employees</h3>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Employees: {sellers.length}. KPI rows: {kpi.length}.
        </p>
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Alerts & Notifications</h3>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-[var(--fg)]">
            <input
              type="checkbox"
              checked={lowStockSound}
              onChange={toggleLowStockSound}
              className="h-4 w-4 rounded border-[var(--stroke)] accent-teal-600"
            />
            Low-stock sound alert
          </label>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Plays a beep sound when products fall below their low-stock threshold.
        </p>
      </div>
    </div>
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-[var(--fg)]">Backups</h3>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Backup folder: <span className="font-semibold text-[var(--fg)]">{settings.backupPath || "—"}</span>
      </p>
      <p className="text-xs text-[var(--muted)]">Last backup: {backupStatus}</p>
      {backupErr && <p className="mt-2 text-xs text-red-400">{backupErr}</p>}
      <button
        className="mt-3 rounded-md bg-teal-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        onClick={runBackup}
        disabled={backupBusy}
        type="button"
      >
        {backupBusy ? "Backing up..." : "Backup now"}
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--fg)]"
          onClick={async () => {
            try {
              const api = (window as any).api;
              const filePath = await api?.chooseRestoreDb?.();
              if (!filePath) return;
              const ok = window.confirm(
                "Restore will replace the current database and restart the local API. Continue?"
              );
              if (!ok) return;
              await api?.restoreDb?.(filePath);
              window.location.reload();
            } catch (e: any) {
              setBackupErr(e?.message ?? "Restore failed");
            }
          }}
          type="button"
        >
          Restore from backup…
        </button>
        <button
          className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200"
          onClick={async () => {
            setResetVal("");
            setResetErr(null);
            setResetOpen(true);
          }}
          type="button"
        >
          Start fresh (Reset DB)…
        </button>
        <p className="text-xs text-[var(--muted)]">
          Use when moving data to a new computer or rolling back.
        </p>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Tip: use a folder like <span className="font-semibold">C:\SellaBackups</span> or an external drive.
      </p>
    </div>
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-[var(--fg)]">Employees (PIN login)</h3>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Add employees with a <span className="font-semibold">4‑digit PIN</span>. Sales/returns will be attributed to the logged-in employee.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <TextField
          label="Name"
          value={empForm.name}
          onChange={(v) => setEmpForm((p) => ({ ...p, name: v }))}
        />
        <SelectField
          label="Role"
          value={empForm.role}
          onChange={(v) => setEmpForm((p) => ({ ...p, role: v as any }))}
          options={[
            { value: "seller", label: "Seller" },
            { value: "admin", label: "Admin" },
          ]}
        />
        <TextField
          label="PIN (4 digits)"
          type="password"
          value={empForm.pin}
          onChange={(v) => setEmpForm((p) => ({ ...p, pin: v }))}
        />
        <label className="block">
          <span className="text-xs font-medium text-[var(--muted)]">Active</span>
          <select
            value={empForm.active ? "1" : "0"}
            onChange={(e) => setEmpForm((p) => ({ ...p, active: e.target.value === "1" }))}
            className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </label>
      </div>
      {empErr && <p className="mt-2 text-sm text-red-400">{empErr}</p>}
      <button
        className="mt-3 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
        onClick={async () => {
          setEmpErr(null);
          try {
            const name = empForm.name.trim();
            const pin = empForm.pin.trim();
            if (!name) throw new Error("Employee name is required");
            if (!/^[0-9]{4}$/.test(pin)) throw new Error("PIN must be exactly 4 digits");
            await api("/sellers", {
              method: "POST",
              body: JSON.stringify({ name, role: empForm.role, pin, active: empForm.active }),
            });
            setEmpForm({ name: "", role: "seller", pin: "", active: true });
            qc.invalidateQueries({ queryKey: ["sellers"] });
          } catch (e: any) {
            setEmpErr(e?.message ?? "Failed to add employee");
          }
        }}
        type="button"
      >
        Add employee
      </button>
      <div className="mt-4 overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[var(--muted)]">
            <tr>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Role</th>
              <th className="px-2 py-1">Active</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sellers.map((s) => (
              <tr key={s.id} className="border-t border-[var(--stroke)]">
                <td className="px-2 py-1 text-[var(--fg)]">{s.name}</td>
                <td className="px-2 py-1 text-[var(--muted)]">{s.role}</td>
                <td className="px-2 py-1 text-[var(--muted)]">{s.active ? "Yes" : "No"}</td>
                <td className="px-2 py-1">
                  <button
                    className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--fg)]"
                    onClick={async () => {
                      setPinResetSeller(s);
                      setPinResetVal("");
                      setPinResetErr(null);
                      setPinResetOpen(true);
                    }}
                    type="button"
                  >
                    Reset PIN
                  </button>{" "}
                  <button
                    className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--fg)]"
                    onClick={async () => {
                      await api(`/sellers/${s.id}`, {
                        method: "PUT",
                        body: JSON.stringify({ active: !s.active }),
                      });
                      qc.invalidateQueries({ queryKey: ["sellers"] });
                    }}
                    type="button"
                  >
                    {s.active ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
            {sellers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-3 text-xs text-[var(--muted)]">
                  No employees yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
      </div>
    </>
  );
};

const PromptModal = ({
  open,
  title,
  message,
  value,
  onChange,
  inputType = "text",
  placeholder,
  confirmText = "OK",
  cancelText = "Cancel",
  helper,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  value: string;
  onChange: (v: string) => void;
  inputType?: "text" | "password";
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  helper?: string;
  error?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) => {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
            {message && <p className="mt-1 text-xs text-[var(--muted)]">{message}</p>}
          </div>
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
            onClick={onCancel}
            type="button"
          >
            ✕
          </button>
        </div>
        <input
          autoFocus
          type={inputType}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
            if (e.key === "Escape") onCancel();
          }}
          className="mt-3 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
        {helper && <p className="mt-2 text-xs text-[var(--muted)]">{helper}</p>}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--fg)]"
            onClick={onCancel}
            type="button"
          >
            {cancelText}
          </button>
          <button
            className="rounded-md bg-teal-600 px-3 py-2 text-xs font-semibold text-white"
            onClick={onConfirm}
            type="button"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

const TextField = ({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) => (
  <label className="block">
    <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
    />
  </label>
);

const NumberField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) => (
  <label className="block">
    <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
    />
  </label>
);

const SelectField = ({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) => (
  <label className="block">
    <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </label>
);

// Scanner + pairing utilities
type ScannerMode = "usb" | "camera";

const ScannerPanel = ({
  onScan,
  mobileLink,
}: {
  onScan: (code: string) => void;
  mobileLink: string;
}) => {
  const [mode, setMode] = useState<ScannerMode>("usb");
  const [input, setInput] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);

  const handleCommit = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      setLastScan(trimmed);
      onScan(trimmed);
    },
    [onScan]
  );

  useEffect(() => {
    const channel = new BroadcastChannel(SCAN_CHANNEL);
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleCommit(event.data);
      }
    };
    return () => channel.close();
  }, [handleCommit]);

  return (
    <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--card)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
            Intake
          </p>
          <h2 className="text-lg font-semibold text-[var(--fg)]">
            Barcode & camera capture
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            className={`rounded-md px-3 py-1 text-sm ${
              mode === "usb"
                ? "bg-teal-600 text-white"
                : "bg-[var(--surface)] text-[var(--fg)]"
            }`}
            onClick={() => {
              setMode("usb");
              setCameraActive(false);
            }}
          >
            USB scanner
          </button>
          <button
            className={`rounded-md px-3 py-1 text-sm ${
              mode === "camera"
                ? "bg-teal-600 text-white"
                : "bg-[var(--surface)] text-[var(--fg)]"
            }`}
            onClick={() => {
              setMode("camera");
              setCameraActive(true);
            }}
          >
            Camera
          </button>
        </div>
      </div>

      {mode === "usb" ? (
        <div className="mt-4 space-y-2">
          <label className="block">
            <span className="text-xs font-medium text-[var(--muted)]">Scan or type</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCommit(input);
                  setInput("");
                }
              }}
              autoFocus
              className="mt-1 w-full rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)] shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="Point USB scanner here"
            />
          </label>
          <p className="text-xs text-[var(--muted)]">
            USB scanners act like keyboards—keep this field focused for rapid intake.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <CameraScanner
            active={cameraActive}
            onScan={(code) => {
              handleCommit(code);
            }}
          />
          <p className="text-xs text-[var(--muted)]">
            Uses the built-in camera. Allow permission to auto-capture codes.
          </p>
        </div>
      )}

      <MobilePairCard mobileLink={mobileLink} />

      {lastScan && (
        <div className="mt-3 rounded-md border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
          Last scan: <span className="font-semibold text-[var(--fg)]">{lastScan}</span>
        </div>
      )}
    </div>
  );
};

// Toast notification component
const ScanToast = ({ message, type }: { message: string; type: "success" | "warning" }) => (
  <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-pulse ${
    type === "success" ? "bg-teal-600 text-white" : "bg-amber-600 text-white"
  }`}>
    {message}
  </div>
);

/**
 * ENTERPRISE-GRADE BARCODE SCANNER
 * Using ZXing (@zxing/browser) - industry standard offline scanner
 * 
 * Features:
 * - 100% offline (no cloud, no API)
 * - Smart cooldown logic (3s for same barcode)
 * - Frame debouncing (500ms)
 * - Low-light optimized
 * - Multi-format support (EAN-13, UPC, Code128, QR, etc.)
 * - External camera support (Iriun, USB webcams)
 */
const CameraScanner = ({
  active,
  onScan,
}: {
  active: boolean;
  onScan: (code: string) => void;
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsRef = useRef<any>(null);
  const readerRef = useRef<MultiFormatReader | null>(null);
  
  // ===== CORE SCANNER STATE (from specs) =====
  const lastScannedBarcodeRef = useRef<string | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const lastFrameProcessTimeRef = useRef<number>(0);
  const SAME_BARCODE_COOLDOWN = 3000; // 3 seconds
  const FRAME_DEBOUNCE_MS = 200; // 200ms frame debounce (optimized for speed)
  
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [flashOn, setFlashOn] = useState(false);
  const [hasFlash, setHasFlash] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "warning" } | null>(null);
  const [lastDetected, setLastDetected] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);

  // Load available cameras on mount
  useEffect(() => {
    const loadCameras = async () => {
      try {
        // Request permission first to get camera labels
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
        tempStream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);
        
        // Auto-select: prioritize Iriun > external/USB > back camera > first available
        const iriun = videoDevices.find(d => d.label.toLowerCase().includes('iriun'));
        const external = videoDevices.find(d => 
          d.label.toLowerCase().includes('external') || 
          d.label.toLowerCase().includes('usb') ||
          d.label.toLowerCase().includes('webcam')
        );
        const back = videoDevices.find(d => 
          d.label.toLowerCase().includes('back') || 
          d.label.toLowerCase().includes('rear') ||
          d.label.toLowerCase().includes('environment')
        );
        const selected = iriun || external || back || videoDevices[0];
        if (selected) setSelectedCamera(selected.deviceId);
      } catch (err) {
        setError("Camera permission denied. Please allow camera access.");
      }
    };
    loadCameras();
  }, []);

  // Auto-hide toast after 2 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  /**
   * SCAN PROCESSING ALGORITHM (from specs) - OPTIMIZED
   * Golden Rule: One scan = one intentional action
   * Optimized for speed: minimal state updates, batched operations
   */
  const handleBarcodeDetected = useCallback((barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed) return;
    
    const now = Date.now();
    
    // Frame debouncing - prevent processing same frame multiple times
    if (now - lastFrameProcessTimeRef.current < FRAME_DEBOUNCE_MS) {
      return;
    }
    lastFrameProcessTimeRef.current = now;
    
    const lastBarcode = lastScannedBarcodeRef.current;
    const lastTime = lastScanTimeRef.current;
    
    // Case 1: New barcode (different product) - ADD IMMEDIATELY
    if (trimmed !== lastBarcode) {
      lastScannedBarcodeRef.current = trimmed;
      lastScanTimeRef.current = now;
      // Batch state updates for performance
      requestAnimationFrame(() => {
        setLastDetected(trimmed);
        setScanCount(c => c + 1);
        setToast({ message: "Product added", type: "success" });
      });
      // Scanner success sound (new MP3-based beep)
      playScanSound();
      onScan(trimmed); // Call immediately (non-blocking)
      return;
    }
    
    // Case 2: Same barcode but cooldown passed - ADD (quantity +1)
    if (trimmed === lastBarcode && now - lastTime >= SAME_BARCODE_COOLDOWN) {
      lastScanTimeRef.current = now;
      // Batch state updates
      requestAnimationFrame(() => {
        setScanCount(c => c + 1);
        setToast({ message: "Product added", type: "success" });
      });
      playScanSound();
      onScan(trimmed);
      return;
    }
    
    // Case 3: Same barcode, cooldown NOT passed - IGNORE completely
    // Show toast but NO beep (deferred to avoid blocking)
    const remaining = Math.ceil((SAME_BARCODE_COOLDOWN - (now - lastTime)) / 1000);
    requestAnimationFrame(() => {
      setToast({ message: `Wait ${remaining}s before scanning again`, type: "warning" });
    });
  }, [onScan]);

  // Toggle flashlight
  const toggleFlash = useCallback(async () => {
    if (!controlsRef.current) return;
    try {
      const stream = videoRef.current?.srcObject as MediaStream;
      const track = stream?.getVideoTracks()[0];
      if (track) {
        const newState = !flashOn;
        await track.applyConstraints({ advanced: [{ torch: newState } as any] });
        setFlashOn(newState);
      }
    } catch {
      // Flash not supported
    }
  }, [flashOn]);

  // Optimized scanning effect - manual frame processing for speed and control
  useEffect(() => {
    if (!active) {
      // Stop scanner when page is not active (performance rule)
      if (controlsRef.current) {
        try { controlsRef.current.stop(); } catch {}
        controlsRef.current = null;
      }
      if (readerRef.current) {
        try {
          // MultiFormatReader doesn't require reset, but we clear the ref for safety.
        } catch {}
        readerRef.current = null;
      }
      setScanning(false);
      return;
    }
    
    if (!selectedCamera || !videoRef.current) return;
    
    let mounted = true;
    let animationFrameId: number | null = null;
    let decodeCanvas: HTMLCanvasElement | null = null;
    let decodeCtx: CanvasRenderingContext2D | null = null;
    let isDecoding = false; // Prevent concurrent decoding
    setError(null);
    
    const startScanner = async () => {
      try {
        // Stop any existing stream first
        if (videoRef.current?.srcObject) {
          const oldStream = videoRef.current.srcObject as MediaStream;
          oldStream.getTracks().forEach(t => t.stop());
        }
        
        // Optimized camera constraints for FAST autofocus and low latency
        const constraints: MediaStreamConstraints = {
          video: {
            deviceId: { exact: selectedCamera },
            // Lower resolution = faster processing, but still good quality
            width: { ideal: 960, max: 1280 },
            height: { ideal: 720, max: 960 },
            frameRate: { ideal: 30, max: 30 },
            // Critical: Enable autofocus immediately
            facingMode: undefined, // Let device choose best
          },
          audio: false,
        };
        
        // Get stream with optimized settings
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() as any;
        
        // Check flash capability
        if (caps?.torch) {
          setHasFlash(true);
        }
        
        // Apply FAST autofocus and exposure settings IMMEDIATELY
        const trackConstraints: any = {
          advanced: [] as any[],
        };
        
        // Prioritize speed over quality for autofocus
        if (caps?.focusMode?.includes('continuous')) {
          trackConstraints.advanced.push({ focusMode: 'continuous' });
        } else if (caps?.focusMode?.includes('single-shot')) {
          trackConstraints.advanced.push({ focusMode: 'single-shot' });
        }
        
        // Fast exposure for low-light
        if (caps?.exposureMode?.includes('continuous')) {
          trackConstraints.advanced.push({ exposureMode: 'continuous' });
        }
        
        // Apply constraints immediately for faster focus
        if (trackConstraints.advanced.length > 0) {
          track.applyConstraints(trackConstraints).catch(() => {});
        }
        
        // Set video source
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        
        // Create hidden canvas for decoding (avoids UI lag)
        decodeCanvas = document.createElement('canvas');
        decodeCtx = decodeCanvas.getContext('2d', { 
          willReadFrequently: true,
          alpha: false, // No alpha = faster
        });
        
        // Configure ZXing hints for retail barcode scanning (optimized for EAN/UPC/Code128/Code39)
        const hints = new Map();
        // TRY_HARDER improves accuracy but is slower - enable for better detection
        hints.set(DecodeHintType.TRY_HARDER, true);
        // Explicitly set only the required retail formats
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
        ]);
        // Character set hint for better text extraction
        hints.set(DecodeHintType.CHARACTER_SET, "ISO-8859-1");
        
        // Create reader once (ZXing library, fully offline)
        const reader = new MultiFormatReader();
        reader.setHints(hints);
        readerRef.current = reader;
        
        // Frame processing loop - decode every frame but throttle decode attempts
        let lastDecodeAttempt = 0;
        const DECODE_THROTTLE_MS = 100; // Decode max every 100ms (10 attempts per second)
        
        const processFrame = () => {
          if (!mounted || !videoRef.current || !decodeCanvas || !decodeCtx) {
            animationFrameId = requestAnimationFrame(processFrame);
            return;
          }
          
          // Throttle decode attempts to prevent CPU overload
          const now = Date.now();
          if (isDecoding || (now - lastDecodeAttempt) < DECODE_THROTTLE_MS) {
            animationFrameId = requestAnimationFrame(processFrame);
            return;
          }
          lastDecodeAttempt = now;
          
          const video = videoRef.current;
          
          // CRITICAL: Only process if video has enough data for reliable decoding
          if (video.readyState < video.HAVE_ENOUGH_DATA) {
            animationFrameId = requestAnimationFrame(processFrame);
            return;
          }
          
          // Ensure video dimensions are valid
          const videoWidth = video.videoWidth || 640;
          const videoHeight = video.videoHeight || 480;
          if (videoWidth <= 0 || videoHeight <= 0) {
            animationFrameId = requestAnimationFrame(processFrame);
            return;
          }
          
          // Use optimal canvas size for decoding (not too small, not too large)
          const scale = videoWidth > 1280 ? 1280 / videoWidth : 1;
          const canvasWidth = Math.floor(videoWidth * scale);
          const canvasHeight = Math.floor(videoHeight * scale);
          if (canvasWidth <= 0 || canvasHeight <= 0) {
            animationFrameId = requestAnimationFrame(processFrame);
            return;
          }
          
          // Update canvas size only if changed (performance optimization)
          if (decodeCanvas.width !== canvasWidth || decodeCanvas.height !== canvasHeight) {
            decodeCanvas.width = canvasWidth;
            decodeCanvas.height = canvasHeight;
          }
          
          // Draw video frame to canvas (must be synchronous for accurate frame capture)
          decodeCtx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
          
          // Decode synchronously to avoid frame timing issues
          isDecoding = true;
          try {
            if (!readerRef.current) {
              isDecoding = false;
              animationFrameId = requestAnimationFrame(processFrame);
              return;
            }

            // Get image data from canvas (RGBA format)
            const imageData = decodeCtx.getImageData(0, 0, canvasWidth, canvasHeight);
            const rgbaData = imageData.data;
            
            // Convert RGBA to grayscale luminance array (required by ZXing)
            const luminances = new Uint8ClampedArray(canvasWidth * canvasHeight);
            for (let i = 0; i < rgbaData.length; i += 4) {
              // Convert RGBA to grayscale using standard formula
              const r = rgbaData[i];
              const g = rgbaData[i + 1];
              const b = rgbaData[i + 2];
              const gray = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
              luminances[i / 4] = gray;
            }
            
            // Create ZXing source from luminance data
            const source = new RGBLuminanceSource(luminances, canvasWidth, canvasHeight);
            const bitmap = new BinaryBitmap(new HybridBinarizer(source));
            
            // Attempt decode with proper error handling
            const result = readerRef.current.decode(bitmap);

            if (result && mounted) {
              const barcodeText = result.getText();
              if (barcodeText && barcodeText.trim()) {
                handleBarcodeDetected(barcodeText.trim());

                // Draw success indicator on overlay canvas
                if (canvasRef.current && videoRef.current) {
                  const overlayCtx = canvasRef.current.getContext("2d");
                  if (overlayCtx) {
                    const vw = video.videoWidth || 320;
                    const vh = video.videoHeight || 240;
                    canvasRef.current.width = vw;
                    canvasRef.current.height = vh;
                    overlayCtx.clearRect(0, 0, vw, vh);

                    // Green highlight
                    overlayCtx.strokeStyle = "#10b981";
                    overlayCtx.lineWidth = 4;
                    const boxWidth = vw * 0.7;
                    const boxHeight = 80;
                    const x = (vw - boxWidth) / 2;
                    const y = (vh - boxHeight) / 2;
                    overlayCtx.strokeRect(x, y, boxWidth, boxHeight);
                    overlayCtx.fillStyle = "rgba(16, 185, 129, 0.3)";
                    overlayCtx.fillRect(x, y, boxWidth, boxHeight);

                    // Clear after short delay
                    setTimeout(() => {
                      if (canvasRef.current) {
                        const ctx2 = canvasRef.current.getContext("2d");
                        if (ctx2) ctx2.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                      }
                    }, 200);
                  }
                }
              }
            }
          } catch (e: any) {
              // NotFoundException is expected when no barcode is in frame - this is normal
              // Only log unexpected errors for debugging
              if (!(e instanceof NotFoundException)) {
                // Silent continue - decode errors are normal during scanning
              }
            } finally {
              isDecoding = false;
            }
          
          // Continue scanning loop (60fps = ~16ms per frame, but we decode async)
          animationFrameId = requestAnimationFrame(processFrame);
        };
        
        // Start processing loop
        animationFrameId = requestAnimationFrame(processFrame);
        
        if (mounted) setScanning(true);
        
      } catch (err: any) {
        isDecoding = false;
        if (mounted) {
          const msg = err?.message || "Failed to start scanner";
          if (msg.includes("Permission") || msg.includes("NotAllowed")) {
            setError("Camera permission denied. Please allow access.");
          } else if (msg.includes("NotFound") || msg.includes("DevicesNotFound")) {
            setError("No camera found. Please connect a camera.");
          } else {
            setError(msg);
          }
          setScanning(false);
        }
      }
    };
    
    startScanner();

    // Cleanup on unmount or when inactive (no memory leaks, no background scanning)
    return () => {
      mounted = false;
      isDecoding = false;
      
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      
      if (controlsRef.current) {
        try { controlsRef.current.stop(); } catch {}
        controlsRef.current = null;
      }
      
      if (readerRef.current) {
        try { readerRef.current.reset(); } catch {}
        readerRef.current = null;
      }
      
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(t => t.stop());
        videoRef.current.srcObject = null;
      }
      
      // Clean up decode canvas
      decodeCanvas = null;
      decodeCtx = null;
      
      setFlashOn(false);
      setScanning(false);
      setHasFlash(false);
    };
  }, [active, selectedCamera, handleBarcodeDetected]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--stroke)] bg-[var(--surface)]">
      {toast && <ScanToast message={toast.message} type={toast.type} />}
      
      {/* Camera selector - important for Iriun and external cameras */}
      {cameras.length > 0 && (
        <div className="px-3 py-2 border-b border-[var(--stroke)] bg-[var(--card)]">
          <label className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted)]">Camera:</span>
            <select
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="flex-1 rounded border border-[var(--stroke)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
            >
              {cameras.map((cam, idx) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `Camera ${idx + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      
      {/* Video with canvas overlay for bounding box */}
      <div className="relative bg-gray-900">
        <video 
          ref={videoRef} 
          className="h-56 w-full object-cover" 
          muted 
          playsInline 
        />
        <canvas 
          ref={canvasRef} 
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
        
        {/* Scan guide overlay - shows where to position barcode */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div 
            className={`w-3/4 h-20 border-2 rounded-lg transition-all duration-200 ${
              lastDetected 
                ? "border-emerald-500 bg-emerald-500/10 shadow-lg shadow-emerald-500/20" 
                : scanning 
                  ? "border-white/70 animate-pulse" 
                  : "border-dashed border-white/30"
            }`}
          >
            {/* Corner markers for professional look */}
            <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-white rounded-tl" />
            <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-white rounded-tr" />
            <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-white rounded-bl" />
            <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-white rounded-br" />
          </div>
        </div>
        
        {/* Status badge - top left */}
        <div className="absolute top-2 left-2">
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium backdrop-blur-sm ${
            scanning 
              ? "bg-emerald-500/90 text-white" 
              : error 
                ? "bg-red-500/90 text-white" 
                : "bg-gray-800/90 text-gray-300"
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              scanning ? "bg-white animate-pulse" : error ? "bg-red-300" : "bg-gray-500"
            }`} />
            {scanning ? "Ready to Scan" : error ? "Error" : "Starting..."}
          </div>
        </div>
        
        {/* Scan count - top right */}
        {scanCount > 0 && (
          <div className="absolute top-2 right-2 bg-emerald-600/90 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-full font-medium">
            ✓ {scanCount}
          </div>
        )}
        
        {/* Last detected barcode - bottom center */}
        {lastDetected && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur-sm text-emerald-400 text-xs px-3 py-1.5 rounded-lg font-mono">
            {lastDetected}
          </div>
        )}
        
        {/* Error overlay with retry UI */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="text-center px-4">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-red-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <p className="text-red-400 text-sm font-medium">{error}</p>
              <p className="text-gray-400 text-xs mt-1">Check camera permissions or select a different camera</p>
              <button
                onClick={() => {
                  setError(null);
                  // Trigger re-mount by changing camera
                  const current = selectedCamera;
                  setSelectedCamera("");
                  setTimeout(() => setSelectedCamera(current), 100);
                }}
                className="mt-3 px-4 py-1.5 bg-teal-600 hover:bg-teal-500 text-white text-xs rounded-lg transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
      
      {/* Bottom bar with controls */}
      <div className="flex items-center justify-between px-3 py-2 text-xs border-t border-[var(--stroke)] bg-[var(--card)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--muted)]">
            {scanning 
              ? "Align barcode within the frame" 
              : "Waiting for camera..."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasFlash && (
            <button
              onClick={toggleFlash}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                flashOn 
                  ? "bg-amber-500 text-white" 
                  : "bg-[var(--surface)] border border-[var(--stroke)] text-[var(--fg)] hover:bg-[var(--stroke)]"
              }`}
              title="Toggle flashlight for low-light scanning"
            >
              <svg className="w-3.5 h-3.5" fill={flashOn ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {flashOn ? "ON" : "Flash"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const MobilePairCard = ({ mobileLink }: { mobileLink: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-[var(--stroke)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Mobile companion</p>
          <p className="text-sm font-semibold text-[var(--fg)]">
            Pair a phone to scan and push codes here
          </p>
        </div>
        <button
          className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
          onClick={() => {
            navigator.clipboard
              .writeText(mobileLink)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)] break-all">{mobileLink}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Open on a phone to use its camera. We mirror scans into this desktop session.
      </p>
    </div>
  );
};

const Shell = ({
  children,
  theme,
  onToggleTheme,
  role,
  businessName,
  branches,
  branchId,
  onBranchChange,
  sellerName,
  deviceId,
  page,
  onPageChange,
  offlineQueue,
  canGoBack,
  onBack,
}: {
  children: React.ReactNode;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  role: Role;
  businessName: string;
  branches: Branch[];
  branchId: string;
  onBranchChange: (id: string) => void;
  sellerName: string;
  deviceId: string;
  page: Page;
  onPageChange: (p: Page) => void;
  offlineQueue: number;
  canGoBack?: boolean;
  onBack?: () => void;
}) => {
  const roleNav =
    role === "seller"
      ? [
          { id: "sell", label: "Sell" as Page },
          { id: "returns", label: "Returns" as Page },
          { id: "products", label: "Inventory" as Page },
          { id: "services", label: "Services" as Page },
          { id: "expenses", label: "Expenses" as Page },
          { id: "mysales", label: "My sales" as Page },
        ]
      : [
          { id: "dashboard", label: "Dashboard" as Page },
          { id: "sell", label: "Sell" as Page },
          { id: "inventory", label: "Inventory" as Page },
          { id: "products", label: "Products" as Page },
          { id: "services", label: "Services" as Page },
          { id: "employees", label: "Employees" as Page },
          { id: "accounts", label: "Accounts" as Page },
          { id: "expenses", label: "Expenses" as Page },
          { id: "reports", label: "Reports" as Page },
          { id: "admin", label: "Admin" as Page },
        ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" data-theme={theme}>
      <div className="flex min-h-screen">
        <SideRail navItems={roleNav} active={page} onNavigate={onPageChange} />
        <div className="flex-1">
          <TopBar
            theme={theme}
            onToggleTheme={onToggleTheme}
            role={role}
            businessName={businessName}
            branches={branches}
            branchId={branchId}
            onBranchChange={onBranchChange}
            sellerName={sellerName}
            deviceId={deviceId}
            offlineQueue={offlineQueue}
            canGoBack={!!canGoBack}
            onBack={onBack}
          />
          <div className="px-4 pb-6 pt-4 md:px-8">{children}</div>
        </div>
      </div>
    </div>
  );
};

const TopBar = ({
  theme,
  onToggleTheme,
  role,
  businessName,
  branches,
  branchId,
  onBranchChange,
  sellerName,
  deviceId,
  offlineQueue,
  canGoBack,
  onBack,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  role: Role;
  businessName: string;
  branches: Branch[];
  branchId: string;
  onBranchChange: (id: string) => void;
  sellerName: string;
  deviceId: string;
  offlineQueue: number;
  canGoBack: boolean;
  onBack?: () => void;
}) => (
  <header className="sticky top-0 z-10 border-b border-[var(--stroke)] bg-[var(--surface)]">
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-full border border-[var(--stroke)] bg-[var(--card)] px-3 py-2 text-xs font-semibold text-[var(--fg)] disabled:opacity-40"
          onClick={() => onBack?.()}
          disabled={!canGoBack}
          type="button"
          title="Back"
        >
          Back
        </button>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-white font-semibold">
          OP
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{businessName}</p>
          <p className="text-sm font-semibold text-[var(--fg)]">
            Branch ·{" "}
            <select
              value={branchId}
              onChange={(e) => onBranchChange(e.target.value)}
              className="rounded-md border border-[var(--stroke)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--fg)] focus:border-teal-500 focus:outline-none"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </p>
        </div>
        <span className="accent-chip rounded-full px-3 py-1 text-xs font-semibold">
          API {API_BASE}
        </span>
        <span className="flex items-center gap-1 rounded-full bg-[var(--surface)] px-3 py-1 text-xs text-teal-300">
          <span className="h-2 w-2 rounded-full bg-teal-400" />
          Offline ready
        </span>
        <span className="rounded-full bg-[var(--surface)] px-3 py-1 text-xs text-[var(--muted)]">
          Queue: {offlineQueue}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-full border border-[var(--stroke)] bg-[var(--card)] px-3 py-1 text-xs text-[var(--fg)]">
          {sellerName} • {role} • Device {deviceId || "—"}
        </div>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button
          className="rounded-full border border-[var(--stroke)] bg-[var(--card)] px-3 py-1 text-xs font-semibold text-[var(--fg)]"
          onClick={() => {
            localStorage.clear();
            window.location.reload();
          }}
        >
          Logout
        </button>
      </div>
    </div>
  </header>
);

const SideRail = ({
  navItems,
  active,
  onNavigate,
}: {
  navItems: { id: Page; label: string }[];
  active?: Page;
  onNavigate?: (p: Page) => void;
}) => (
  <aside className="sticky top-0 hidden h-screen w-56 flex-col gap-1 border-r border-[var(--stroke)] bg-[var(--surface)]/95 px-3 py-4 backdrop-blur md:flex">
    {navItems.map((item) => (
      <button
        key={item.id}
        onClick={() => onNavigate?.(item.id)}
        className={`rounded-lg px-3 py-2 text-left text-sm font-semibold ${
          active === item.id
            ? "bg-teal-600 text-white"
            : "text-[var(--fg)] hover:bg-[var(--surface)] hover:border hover:border-[var(--stroke)]"
        }`}
      >
        {item.label}
      </button>
    ))}
  </aside>
);

const ThemeToggle = ({
  theme,
  onToggle,
}: {
  theme: "light" | "dark";
  onToggle: () => void;
}) => (
  <button
    onClick={onToggle}
    className="rounded-full border border-[var(--stroke)] bg-[var(--card)] px-3 py-1 text-xs font-semibold text-[var(--fg)] shadow-sm"
  >
    {theme === "light" ? "Dark mode" : "Light mode"}
  </button>
);

const PageHeading = ({
  id,
  title,
  subtitle,
}: {
  id: string;
  title: string;
  subtitle: string;
}) => (
  <div id={id} className="flex flex-col gap-1">
    <h1 className="text-2xl font-semibold text-[var(--fg)]">{title}</h1>
    <p className="text-sm text-[var(--muted)]">{subtitle}</p>
  </div>
);

// Mobile companion view (shares same bundle, simplified chrome)
const MobileScannerScreen = ({
  theme,
  onToggleTheme,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) => {
  const [last, setLast] = useState<string | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(SCAN_CHANNEL);
    channelRef.current = channel;
    return () => channel.close();
  }, []);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" data-theme={theme}>
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Mobile scanner</p>
            <p className="text-lg font-semibold text-[var(--fg)]">Send scans to desktop</p>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <CameraScanner
          active
          onScan={(code) => {
            setLast(code);
            channelRef.current?.postMessage(code);
          }}
        />
        {last && (
          <div className="rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 text-sm">
            Last scan: <span className="font-semibold">{last}</span>
          </div>
        )}
        <p className="text-xs text-[var(--muted)]">
          Keep this tab open while scanning. Desktop pairing uses local network when available.
        </p>
      </div>
    </div>
  );
};

export default App;

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("Renderer crashed:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">
        <p className="text-sm font-semibold">This screen crashed.</p>
        <p className="mt-1 text-xs opacity-90">{this.state.error.message}</p>
        <button
          className="mt-3 rounded-md bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--fg)] border border-[var(--stroke)]"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload app
        </button>
      </div>
    );
  }
}

const receiptHtml = (receipt: any, currency: string, appVersion: string) => {
  const esc = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const fmt = (n: any) => Number(n ?? 0).toFixed(2);

  const toFileUrl = (p: string) => {
    const v = String(p || "");
    if (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("file:") || v.startsWith("data:")) return v;
    // best-effort Windows path -> file URL
    if (/^[a-zA-Z]:\\/.test(v)) return `file:///${v.replace(/\\/g, "/")}`;
    return v;
  };

  const logo = receipt.logo ? toFileUrl(receipt.logo) : "";

  const items = (receipt.lines ?? []) as any[];
  const taxRows = Object.entries(receipt.taxGroups ?? {}) as any[];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Receipt</title>
<style>
  :root{
    --g-900:#064e3b;
    --g-800:#065f46;
    --g-700:#047857;
    --g-200:#bbf7d0;
    --g-100:#dcfce7;
    --g-50:#f0fdf4;
    --ink:#0f172a;
    --muted:#334155;
  }
  *{ box-sizing:border-box; }
  body{ margin:0; padding:4px; background:var(--g-50); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; color:var(--ink); font-size:7px; }
  .wrap{ display:flex; justify-content:center; }
  /* Compact thermal target: 58mm */
  .receipt{
    width: 58mm;
    max-width: 280px;
    min-width: 200px;
    background:#fff;
    border:1px solid var(--g-200);
    border-radius:6px;
    overflow:hidden;
    box-shadow: 0 4px 12px rgba(2,6,23,.06);
  }
  .top{
    background: linear-gradient(135deg, var(--g-800), var(--g-700));
    color:#fff;
    padding:6px 6px 5px;
  }
  .brandRow{ display:flex; gap:5px; align-items:center; }
  .logo{
    width:28px; height:28px; border-radius:6px; background:rgba(255,255,255,.12);
    display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid rgba(255,255,255,.22); flex-shrink:0;
  }
  .logo img{ width:100%; height:100%; object-fit:contain; background:rgba(255,255,255,.08); }
  .title{ font-weight:800; font-size:9px; line-height:1.1; word-break:break-word; }
  .sub{ font-size:7px; opacity:.92; margin-top:1px; word-break:break-word; }
  .metaPills{ display:flex; flex-wrap:wrap; gap:2px; margin-top:4px; }
  .pill{ font-size:6px; padding:2px 4px; border-radius:999px; background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.22); }
  .body{ padding:5px 6px 6px; }
  .kv{ display:flex; justify-content:space-between; gap:3px; font-size:7px; color:var(--muted); margin-top:2px; flex-wrap:wrap; }
  .kv b{ color:var(--ink); word-break:break-all; }
  .divider{ height:1px; background:var(--g-100); margin:5px 0; }
  .sectionTitle{ font-size:7px; font-weight:800; color:var(--g-900); text-transform:uppercase; letter-spacing:.06em; margin:4px 0 2px; }
  table{ width:100%; border-collapse:collapse; }
  th{ text-align:left; font-size:6px; color:var(--muted); font-weight:800; padding:2px 0; border-bottom:1px solid var(--g-100); }
  td{ font-size:7px; padding:2px 0; border-bottom:1px dashed var(--g-100); vertical-align:top; word-break:break-word; }
  td.num{ text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
  .code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; color:var(--g-800); font-size:6px; word-break:break-all; }
  .totalsBox{
    margin-top:5px;
    background:var(--g-50);
    border:1px solid var(--g-100);
    border-radius:6px;
    padding:5px;
  }
  .row{ display:flex; justify-content:space-between; gap:3px; font-size:7px; color:var(--muted); margin:1px 0; flex-wrap:wrap; }
  .row strong{ color:var(--ink); }
  .row.big{ font-size:9px; font-weight:900; color:var(--g-900); margin-top:3px; }
  .note{ font-size:6px; color:var(--muted); margin-top:4px; }
  .footer{
    margin-top:5px;
    text-align:center;
    background:var(--g-50);
    border:1px solid var(--g-100);
    border-radius:6px;
    padding:5px;
  }
  .thanks{ font-size:8px; font-weight:900; color:var(--g-900); word-break:break-word; }
  .small{ font-size:6px; color:var(--muted); margin-top:2px; }
  .built{ font-size:5px; color:var(--muted); margin-top:4px; opacity:0.7; }
  @media print{
    body{ background:#fff; padding:0; font-size:7px; }
    .receipt{ width: 58mm; max-width:280px; min-width:200px; border:none; border-radius:0; box-shadow:none; }
    .top{ border-radius:0; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="receipt">
      <div class="top">
        <div class="brandRow">
          <div class="logo">${logo ? `<img src="${esc(logo)}" alt="logo" />` : `<span style="font-weight:900">SE</span>`}</div>
          <div>
            <div class="title">${esc(receipt.business ?? "")} <span style="opacity:.9">–</span> ${esc(receipt.branch ?? "")}</div>
            <div class="sub">${receipt.poBox ? `PO BOX ${esc(receipt.poBox)} • ` : ""}${receipt.town ? `${esc(receipt.town)} • ` : ""}${receipt.telNo ? `TEL ${esc(receipt.telNo)}` : ""}</div>
            <div class="metaPills">
              <span class="pill">Time: ${esc(receipt.when ?? "")}</span>
              <span class="pill">Transaction #: ${esc(receipt.receiptNo ?? receipt.number ?? "")}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="body">
        <div class="kv"><span>You were served by</span><b>${esc(receipt.seller ?? "")}</b></div>
        <div class="kv"><span>Till Number</span><b>${esc(receipt.tillNumber ?? "")}</b></div>
        <div class="divider"></div>

        <div class="sectionTitle">Items</div>
        <table>
          <thead>
            <tr>
              <th style="width:18%">CODE</th>
              <th>DESCRIPTION</th>
              <th class="num" style="width:10%">QTY</th>
              <th class="num" style="width:16%">PRICE</th>
              <th class="num" style="width:18%">EXTENDED</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (i) => `<tr>
                  <td><span class="code">${esc(i.code ?? "")}</span></td>
                  <td>${esc(i.desc ?? "")}</td>
                  <td class="num">${esc(i.qty ?? "")}</td>
                  <td class="num">${esc(currency)} ${fmt(i.unit)}</td>
                  <td class="num"><strong>${esc(currency)} ${fmt(i.ext)}</strong></td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>

        <div class="totalsBox">
          <div class="row"><span>Totals</span><span></span></div>
          <div class="row"><span>Paid (cash/till/bank)</span><strong>${esc(currency)} ${fmt(receipt.tendered)} (${fmt(receipt.payments?.cash ?? 0)}/${fmt(receipt.payments?.till ?? 0)}/${fmt(receipt.payments?.bank ?? 0)})</strong></div>
          <div class="row"><span>Change</span><strong>${esc(currency)} ${fmt(receipt.change)}</strong></div>
          <div class="row big"><span>TOTAL</span><span>${esc(currency)} ${fmt(receipt.total)}</span></div>
          <div class="divider"></div>
          <div class="row"><span>TOTAL ITEMS</span><strong>${esc(receipt.totalItems ?? 0)}</strong></div>
          <div class="row"><span>TOTAL Weights</span><strong>${fmt(receipt.totalWeights ?? 0)}</strong></div>
          <div class="note">Prices inclusive of taxes where applicable</div>
        </div>

        <div class="sectionTitle" style="margin-top:12px">Tax Details</div>
        <table>
          <thead>
            <tr>
              <th style="width:22%">CODE</th>
              <th class="num" style="width:39%">VATABLE AMT</th>
              <th class="num" style="width:39%">VAT AMT</th>
            </tr>
          </thead>
          <tbody>
            ${taxRows
              .map(
                ([code, v]) => `<tr>
                  <td><span class="code">${esc(code)}</span></td>
                  <td class="num">${esc(currency)} ${fmt((v as any).vatable)}</td>
                  <td class="num">${esc(currency)} ${fmt((v as any).vat)}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>

        ${receipt.customer ? `<div class="kv"><span>Customer</span><b>${esc(receipt.customer)}</b></div>` : ""}
        ${receipt.customerPhone ? `<div class="kv"><span>Phone</span><b>${esc(receipt.customerPhone)}</b></div>` : ""}
        ${receipt.pointsEarned ? `<div class="kv" style="color:var(--g-700)"><span>🎁 Points Earned</span><b>+${fmt(receipt.pointsEarned)}</b></div>` : ""}
        ${receipt.pointsRedeemed ? `<div class="kv" style="color:#ef4444"><span>🔥 Points Redeemed</span><b>-${fmt(receipt.pointsRedeemed)}</b></div>` : ""}

        <div class="divider"></div>
        ${receipt.kraPin ? `<div class="kv"><span>KRA PIN</span><b>${esc(receipt.kraPin)}</b></div>` : ""}
        <div class="kv"><span>SELLAS Offline-POS Ver</span><b>${esc(appVersion)}</b></div>
        <div class="kv"><span>CU Serrial No</span><b>${esc(receipt.cuSerialNo ?? "")}</b></div>
        <div class="kv"><span>CU Invoice No</span><b>${esc(receipt.cuInvoiceNo ?? "")}</b></div>

        <div class="footer">
          <div class="thanks">${esc(receipt.footer ?? "Thank you for your purchase. Welcome back again!")}</div>
          ${receipt.returnPolicy ? `<div class="small" style="margin-top:3px;font-style:italic">${esc(receipt.returnPolicy)}</div>` : ""}
          <div class="built">Built by mokamigeoffrey@gmail.com</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
};

const receiptText = (receipt: any, currency: string, appVersion: string) => {
  const dash = "---------------------------------------------------";
  const rows = (receipt.lines ?? []).map((l: any) => {
    const code = String(l.code ?? "").slice(0, 8).padEnd(8, " ");
    const desc = String(l.desc ?? "").slice(0, 18).padEnd(18, " ");
    const qty = String(l.qty ?? "").toString().padStart(3, " ");
    const price = Number(l.unit ?? 0).toFixed(2).toString().padStart(8, " ");
    const ext = Number(l.ext ?? 0).toFixed(2).toString().padStart(9, " ");
    return `${code} ${desc} ${qty} ${price} ${ext}`;
  });
  const taxRows = Object.entries(receipt.taxGroups ?? {}).map(([code, v]: any) => {
    const vatable = Number(v.vatable ?? 0).toFixed(2).toString().padStart(10, " ");
    const vat = Number(v.vat ?? 0).toFixed(2).toString().padStart(8, " ");
    return `${String(code).padEnd(6, " ")} ${vatable} ${vat}`;
  });
  return [
    `${receipt.business ?? ""} - ${receipt.branch ?? ""}`,
    receipt.poBox ? `PO BOX ${receipt.poBox}` : "",
    receipt.town ? `${receipt.town}` : "",
    receipt.telNo ? `TEL NO: ${receipt.telNo}` : "",
    `Time: ${receipt.when}`,
    `Transaction #: ${receipt.receiptNo ?? receipt.number ?? ""}`,
    dash,
    "CODE     DESCRIPTION          QTY   PRICE   EXTENDED",
    dash,
    ...rows,
    dash,
    `Totals`,
    `Paid: ${currency} ${Number(receipt.tendered ?? 0).toFixed(2)} (cash ${Number(receipt.payments?.cash ?? 0).toFixed(2)}, till ${Number(receipt.payments?.till ?? 0).toFixed(2)}, bank ${Number(receipt.payments?.bank ?? 0).toFixed(2)})`,
    `Change:   ${currency} ${Number(receipt.change ?? 0).toFixed(2)}`,
    dash,
    `TOTAL:    ${currency} ${Number(receipt.total ?? 0).toFixed(2)}`,
    `TOTAL ITEMS: ${Number(receipt.totalItems ?? 0)}`,
    `TOTAL Weights: ${Number(receipt.totalWeights ?? 0).toFixed(2)}`,
    "Prices inclusive of taxes where applicable",
    "TAX DETAILS",
    "CODE   VATABLE AMT   VAT AMT",
    ...taxRows,
    "",
    `You were served by: ${receipt.seller ?? ""}`,
    `Till Number: ${receipt.tillNumber ?? ""}`,
    receipt.customer ? `Customer: ${receipt.customer}` : "",
    receipt.customerPhone ? `Phone: ${receipt.customerPhone}` : "",
    receipt.pointsEarned ? `Points Earned: +${Number(receipt.pointsEarned).toFixed(0)}` : "",
    receipt.pointsRedeemed ? `Points Redeemed: -${Number(receipt.pointsRedeemed).toFixed(0)}` : "",
    dash,
    receipt.kraPin ? `KRA PIN: ${receipt.kraPin}` : "",
    `SELLAS Offline-POS Ver: ${appVersion}`,
    dash,
    `CU Serrial No: ${receipt.cuSerialNo ?? ""}`,
    `CU Invoice No: ${receipt.cuInvoiceNo ?? ""}`,
    "",
    receipt.footer ? String(receipt.footer) : "Thank you. Welcome back again!",
    receipt.returnPolicy ? `Return Policy: ${receipt.returnPolicy}` : "",
    "",
    "Built by mokamigeoffrey@gmail.com",
  ]
    .filter((x) => String(x).trim().length > 0)
    .join("\n");
};

const ReceiptPanel = ({ receipt, currency }: { receipt: any; currency: string }) => {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const [appVer, setAppVer] = useState("1.0.0");

  useEffect(() => {
    const api = (window as any).api;
    api?.appVersion?.()
      .then((v: string) => setAppVer(String(v || "1.0.0")))
      .catch(() => setAppVer("1.0.0"));
  }, []);

  const doPrint = async () => {
    const html = receiptHtml(receipt, currency, appVer);
    const w = window.open("", "_blank");
    if (!w) {
      window.print();
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  const doPdf = async () => {
    setPdfErr(null);
    setPdfBusy(true);
    try {
      const api = (window as any).api;
      const html = receiptHtml(receipt, currency, appVer);
      const b64 = await api?.printToPdf?.(html);
      if (!b64) throw new Error("PDF generation not available");
      const bytes = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt_${receipt.receiptNo ?? receipt.number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setPdfErr(e?.message ?? "PDF failed");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-[var(--stroke)] bg-white p-4 shadow-sm print:bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-emerald-700">Sales Receipt</p>
          <p className="text-sm font-semibold text-emerald-900">
            {receipt.business} • {receipt.branch}
          </p>
          <p className="text-xs text-emerald-800">
            Transaction #{receipt.receiptNo ?? receipt.number} • {receipt.when}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm"
            onClick={doPrint}
            type="button"
          >
            Print
          </button>
          <button
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm disabled:opacity-50"
            onClick={doPdf}
            disabled={pdfBusy}
            type="button"
          >
            {pdfBusy ? "PDF..." : "Download PDF"}
          </button>
        </div>
      </div>
      {pdfErr && <p className="mt-2 text-xs text-red-500">{pdfErr}</p>}
      <div
        className="mt-3 overflow-auto rounded-lg border border-emerald-100 bg-emerald-50"
        style={{ maxHeight: 520 }}
        dangerouslySetInnerHTML={{ __html: receiptHtml(receipt, currency, appVer) }}
      />
    </div>
  );
};

