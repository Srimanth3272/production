var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/index.ts
import express2 from "express";

// server/routes.ts
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  companies: () => companies,
  insertCompanySchema: () => insertCompanySchema,
  insertMonitoringLogSchema: () => insertMonitoringLogSchema,
  insertUserSchema: () => insertUserSchema,
  monitoringLogs: () => monitoringLogs,
  users: () => users
});
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, decimal, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
var users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull()
});
var companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  email: text("email"),
  ceoName: text("ceo_name"),
  industry: text("industry"),
  location: text("location"),
  country: text("country"),
  revenue: decimal("revenue", { precision: 15, scale: 2 }).notNull(),
  qualifiedAt: timestamp("qualified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  dataSource: text("data_source").notNull(),
  isVerified: boolean("is_verified").notNull().default(true),
  lastUpdated: timestamp("last_updated").notNull().default(sql`CURRENT_TIMESTAMP`),
  metadata: jsonb("metadata")
});
var monitoringLogs = pgTable("monitoring_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  timestamp: timestamp("timestamp").notNull().default(sql`CURRENT_TIMESTAMP`),
  action: text("action").notNull(),
  companyId: varchar("company_id").references(() => companies.id),
  details: jsonb("details"),
  source: text("source").notNull()
});
var insertUserSchema = createInsertSchema(users).omit({
  id: true
});
var insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  qualifiedAt: true,
  lastUpdated: true
});
var insertMonitoringLogSchema = createInsertSchema(monitoringLogs).omit({
  id: true,
  timestamp: true
});

// server/db.ts
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?"
  );
}
var pool = new Pool({ connectionString: process.env.DATABASE_URL });
var db = drizzle({ client: pool, schema: schema_exports });

// server/storage.ts
import { eq, desc, and, ilike, gte, sql as sql2, count } from "drizzle-orm";
var DatabaseStorage = class {
  async getUser(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || void 0;
  }
  async getUserByUsername(username) {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || void 0;
  }
  async createUser(insertUser) {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }
  async getCompanies(options = {}) {
    const { search, industry, country, limit = 25, offset = 0 } = options;
    const conditions = [];
    if (search) {
      conditions.push(ilike(companies.name, `%${search}%`));
    }
    if (industry) {
      conditions.push(eq(companies.industry, industry));
    }
    if (country) {
      conditions.push(eq(companies.country, country));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : void 0;
    const [totalResult] = await db.select({ count: count() }).from(companies).where(whereClause);
    const companiesResult = await db.select().from(companies).where(whereClause).orderBy(desc(companies.qualifiedAt)).limit(limit).offset(offset);
    return {
      companies: companiesResult,
      total: totalResult.count
    };
  }
  async getCompanyByName(name) {
    const [company] = await db.select().from(companies).where(eq(companies.name, name));
    return company || void 0;
  }
  async createCompany(company) {
    const [newCompany] = await db.insert(companies).values(company).returning();
    return newCompany;
  }
  async updateCompany(id, updates) {
    const [updatedCompany] = await db.update(companies).set({ ...updates, lastUpdated: sql2`CURRENT_TIMESTAMP` }).where(eq(companies.id, id)).returning();
    return updatedCompany || void 0;
  }
  async deleteCompany(id) {
    const result = await db.delete(companies).where(eq(companies.id, id));
    return (result.rowCount || 0) > 0;
  }
  async getCompaniesAboveRevenue(minRevenue) {
    return await db.select().from(companies).where(gte(companies.revenue, minRevenue.toString())).orderBy(desc(companies.qualifiedAt));
  }
  async getCompanyStats() {
    const [totalResult] = await db.select({ count: count() }).from(companies);
    const [todayResult] = await db.select({ count: count() }).from(companies).where(gte(companies.qualifiedAt, sql2`CURRENT_DATE`));
    const [avgResult] = await db.select({ avg: sql2`AVG(${companies.revenue}::numeric)` }).from(companies);
    const [lastUpdateResult] = await db.select({ lastUpdate: companies.lastUpdated }).from(companies).orderBy(desc(companies.lastUpdated)).limit(1);
    return {
      totalQualified: totalResult.count,
      todayNew: todayResult.count,
      avgRevenue: Math.round((avgResult.avg || 0) / 1e6 * 10) / 10,
      // Convert to millions with 1 decimal
      lastUpdate: lastUpdateResult?.lastUpdate || /* @__PURE__ */ new Date()
    };
  }
  async createMonitoringLog(log2) {
    const [newLog] = await db.insert(monitoringLogs).values(log2).returning();
    return newLog;
  }
  async getRecentLogs(limit = 50) {
    return await db.select().from(monitoringLogs).orderBy(desc(monitoringLogs.timestamp)).limit(limit);
  }
};
var storage = new DatabaseStorage();

// server/services/companyMonitor.ts
var broadcastFunction = null;
function startCompanyMonitor(broadcast) {
  broadcastFunction = broadcast;
  console.log("Company monitor service started");
  setInterval(async () => {
    try {
      const stats = await storage.getCompanyStats();
      if (broadcastFunction) {
        broadcastFunction({
          type: "stats_update",
          data: stats
        });
      }
    } catch (error) {
      console.error("Error sending stats update:", error);
    }
  }, 3e4);
}

// server/test-data.ts
var sampleCompanies = [
  {
    name: "TechFlow Solutions",
    email: "contact@techflow.com",
    ceoName: "Sarah Chen",
    industry: "SaaS Technology",
    location: "San Francisco, CA",
    country: "US",
    revenue: "12500000",
    dataSource: "crunchbase",
    isVerified: true
  },
  {
    name: "GreenEnergy Innovations",
    email: "info@greenenergy.com",
    ceoName: "Michael Rodriguez",
    industry: "Clean Energy",
    location: "Austin, TX",
    country: "US",
    revenue: "15200000",
    dataSource: "clearbit",
    isVerified: true
  },
  {
    name: "HealthTech Analytics",
    email: "hello@healthtech.com",
    ceoName: "Dr. Emily Watson",
    industry: "Healthcare Tech",
    location: "Boston, MA",
    country: "US",
    revenue: "18750000",
    dataSource: "pitchbook",
    isVerified: true
  },
  {
    name: "FinanceAI Corp",
    email: "contact@financeai.com",
    ceoName: "David Kim",
    industry: "Finance",
    location: "New York, NY",
    country: "US",
    revenue: "23400000",
    dataSource: "crunchbase",
    isVerified: true
  },
  {
    name: "RetailOps Platform",
    email: "support@retailops.com",
    ceoName: "Lisa Thompson",
    industry: "Retail",
    location: "Seattle, WA",
    country: "US",
    revenue: "11800000",
    dataSource: "clearbit",
    isVerified: true
  },
  {
    name: "CloudManufacture Systems",
    email: "contact@cloudmanufacture.com",
    ceoName: "Robert Johnson",
    industry: "Manufacturing",
    location: "London",
    country: "UK",
    revenue: "14600000",
    dataSource: "pitchbook",
    isVerified: true
  }
];
async function seedDatabase() {
  console.log("Seeding database with sample companies...");
  try {
    for (const companyData of sampleCompanies) {
      const existing = await storage.getCompanyByName(companyData.name);
      if (!existing) {
        const company = await storage.createCompany(companyData);
        console.log(`Added company: ${company.name}`);
        await storage.createMonitoringLog({
          action: "company_seeded",
          companyId: company.id,
          details: { revenue: company.revenue, source: company.dataSource },
          source: "seed_script"
        });
      } else {
        console.log(`Company already exists: ${companyData.name}`);
      }
    }
    console.log("Database seeding completed successfully!");
  } catch (error) {
    console.error("Error seeding database:", error);
    throw error;
  }
}
async function addNewQualifyingCompany() {
  const newCompany = {
    name: `StartupCorp-${Date.now()}`,
    email: `contact@startup${Date.now()}.com`,
    ceoName: "Alex Johnson",
    industry: "SaaS Technology",
    location: "Palo Alto, CA",
    country: "US",
    revenue: "10500000",
    dataSource: "automated_discovery",
    isVerified: true
  };
  const company = await storage.createCompany(newCompany);
  await storage.createMonitoringLog({
    action: "company_discovered",
    companyId: company.id,
    details: { revenue: company.revenue, source: company.dataSource },
    source: "automated"
  });
  console.log(`Added new qualifying company: ${company.name}`);
  return newCompany;
}

// server/routes.ts
var wss;
function broadcastToClients(message) {
  if (wss) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}
async function registerRoutes(app2) {
  app2.get("/api/companies", async (req, res) => {
    try {
      const { search, industry, country, page = "1", limit = "25" } = req.query;
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;
      const result = await storage.getCompanies({
        search,
        industry,
        country,
        limit: limitNum,
        offset
      });
      res.json({
        companies: result.companies,
        total: result.total,
        page: pageNum,
        totalPages: Math.ceil(result.total / limitNum)
      });
    } catch (error) {
      console.error("Error fetching companies:", error);
      res.status(500).json({ message: "Failed to fetch companies" });
    }
  });
  app2.get("/api/companies/stats", async (req, res) => {
    try {
      const stats = await storage.getCompanyStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });
  app2.post("/api/companies", async (req, res) => {
    try {
      const validatedData = insertCompanySchema.parse(req.body);
      const existingCompany = await storage.getCompanyByName(validatedData.name);
      if (existingCompany) {
        return res.status(409).json({ message: "Company already exists" });
      }
      const company = await storage.createCompany(validatedData);
      await storage.createMonitoringLog({
        action: "company_added",
        companyId: company.id,
        details: { revenue: validatedData.revenue, source: validatedData.dataSource },
        source: "manual"
      });
      broadcastToClients({
        type: "new_company",
        data: company
      });
      res.status(201).json(company);
    } catch (error) {
      console.error("Error creating company:", error);
      res.status(400).json({ message: "Invalid company data" });
    }
  });
  app2.delete("/api/companies/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const success = await storage.deleteCompany(id);
      if (success) {
        await storage.createMonitoringLog({
          action: "company_removed",
          companyId: id,
          details: {},
          source: "manual"
        });
        res.json({ message: "Company deleted successfully" });
      } else {
        res.status(404).json({ message: "Company not found" });
      }
    } catch (error) {
      console.error("Error deleting company:", error);
      res.status(500).json({ message: "Failed to delete company" });
    }
  });
  app2.get("/api/logs", async (req, res) => {
    try {
      const { limit = "50" } = req.query;
      const logs = await storage.getRecentLogs(parseInt(limit));
      res.json(logs);
    } catch (error) {
      console.error("Error fetching logs:", error);
      res.status(500).json({ message: "Failed to fetch logs" });
    }
  });
  app2.get("/api/companies/export", async (req, res) => {
    try {
      const result = await storage.getCompanies({ limit: 1e4 });
      const csv = [
        "Name,Email,CEO,Industry,Location,Country,Revenue,Qualified At,Data Source",
        ...result.companies.map(
          (company) => `"${company.name}","${company.email || ""}","${company.ceoName || ""}","${company.industry || ""}","${company.location || ""}","${company.country || ""}","${company.revenue}","${company.qualifiedAt?.toISOString() || ""}","${company.dataSource}"`
        )
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="companies.csv"');
      res.send(csv);
    } catch (error) {
      console.error("Error exporting companies:", error);
      res.status(500).json({ message: "Failed to export companies" });
    }
  });
  const httpServer = createServer(app2);
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws2) => {
    console.log("New WebSocket connection established");
    ws2.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log("Received WebSocket message:", data);
        if (data.type === "ping") {
          ws2.send(JSON.stringify({ type: "pong" }));
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    });
    ws2.on("close", () => {
      console.log("WebSocket connection closed");
    });
    storage.getCompanyStats().then((stats) => {
      ws2.send(JSON.stringify({
        type: "stats_update",
        data: stats
      }));
    });
  });
  startCompanyMonitor(broadcastToClients);
  app2.post("/api/seed", async (req, res) => {
    try {
      await seedDatabase();
      const stats = await storage.getCompanyStats();
      broadcastToClients({
        type: "stats_update",
        data: stats
      });
      res.json({ message: "Database seeded successfully" });
    } catch (error) {
      console.error("Error seeding database:", error);
      res.status(500).json({ message: "Failed to seed database" });
    }
  });
  app2.post("/api/simulate-discovery", async (req, res) => {
    try {
      const company = await addNewQualifyingCompany();
      broadcastToClients({
        type: "new_company",
        data: company
      });
      const stats = await storage.getCompanyStats();
      broadcastToClients({
        type: "stats_update",
        data: stats
      });
      res.json({ message: "New company discovery simulated", company });
    } catch (error) {
      console.error("Error simulating discovery:", error);
      res.status(500).json({ message: "Failed to simulate discovery" });
    }
  });
  return httpServer;
}

// server/vite.ts
import express from "express";
import fs from "fs";
import path2 from "path";
import { createServer as createViteServer, createLogger } from "vite";

// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...process.env.NODE_ENV !== "production" && process.env.REPL_ID !== void 0 ? [
      await import("@replit/vite-plugin-cartographer").then(
        (m) => m.cartographer()
      ),
      await import("@replit/vite-plugin-dev-banner").then(
        (m) => m.devBanner()
      )
    ] : []
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/vite.ts
import { nanoid } from "nanoid";
var viteLogger = createLogger();
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
async function setupVite(app2, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      }
    },
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html"
      );
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app2) {
  const distPath = path2.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/index.ts
var app = express2();
app.use(express2.json());
app.use(express2.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const start = Date.now();
  const path3 = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path3.startsWith("/api")) {
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    }
  });
  next();
});
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
  });
})();
