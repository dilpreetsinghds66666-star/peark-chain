require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dbFile = path.resolve(process.env.DATABASE_FILE || "./data/perkchain.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet_address TEXT,
  points INTEGER NOT NULL DEFAULT 1250, xp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, partner_id TEXT NOT NULL,
  brand TEXT NOT NULL, discount TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
  points_cost INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', used_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT, status TEXT NOT NULL DEFAULT 'Recorded', created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS nft_mints (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE, token_id TEXT, contract_address TEXT NOT NULL,
  network TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);
const nowIso = () => new Date().toISOString();
const makeId = prefix => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const makeTx = () => "0x" + crypto.randomBytes(32).toString("hex");
const partners = [
  { id:"starbucks", name:"Starbucks (example only)", category:"Coffee & café", initials:"S", color:"#e1f2e7", ink:"#146b45", rate:10, discount:"₹50 Off", description:"Sample offer; not an official Starbucks promotion.", cost:500, codePrefix:"STAR" },
  { id:"nike", name:"Nike (example only)", category:"Sportswear", initials:"N", color:"#eee9e3", ink:"#242424", rate:10, discount:"15% Off", description:"Sample offer; not an official Nike promotion.", cost:800, codePrefix:"NIKE" },
  { id:"samsung", name:"Samsung (example only)", category:"Technology", initials:"S", color:"#e0e9ff", ink:"#1746a2", rate:10, discount:"₹100 Off", description:"Sample offer; not an official Samsung promotion.", cost:1000, codePrefix:"SAMS" },
  { id:"adidas", name:"Adidas (example only)", category:"Sportswear", initials:"A", color:"#f1f1f1", ink:"#222222", rate:10, discount:"10% Off", description:"Sample offer; not an official Adidas promotion.", cost:700, codePrefix:"ADID" },
  { id:"bookmyshow", name:"BookMyShow (example only)", category:"Entertainment", initials:"B", color:"#ffe7eb", ink:"#c41436", rate:10, discount:"₹75 Off", description:"Sample offer; not an official BookMyShow promotion.", cost:750, codePrefix:"BMSH" },
  { id:"reliance", name:"Reliance Digital (example only)", category:"Electronics", initials:"R", color:"#e5f1ff", ink:"#1767a8", rate:10, discount:"12% Off", description:"Sample offer; not an official Reliance Digital promotion.", cost:900, codePrefix:"RDLT" }
];

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

function ensureUser(req, res, next) {
  const userId = String(req.headers["x-perkchain-user"] || "local-customer").slice(0, 80);
  let user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    db.prepare("INSERT INTO users(id,name,points,xp,created_at) VALUES(?,?,?,?,?)")
      .run(userId, "PerkChain Member", 1250, 0, nowIso());
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  }
  req.user = user;
  next();
}
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (req,res) => res.json({ ok:true, app:"PerkChain", database:"connected" }));
app.get("/api/partners", (req,res) => res.json({ partners }));
app.get("/api/state", ensureUser, (req,res) => {
  const user = db.prepare("SELECT id,name,wallet_address,points,xp,created_at FROM users WHERE id=?").get(req.user.id);
  const vouchers = db.prepare("SELECT * FROM vouchers WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
  const activity = db.prepare("SELECT * FROM activity WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(req.user.id);
  const mints = db.prepare("SELECT * FROM nft_mints WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
  res.json({ user, vouchers, activity, mints, partners });
});
app.put("/api/profile", ensureUser, (req,res) => {
  const name = String(req.body.name || "").trim().slice(0,40);
  const wallet = req.body.walletAddress ? String(req.body.walletAddress).trim().slice(0,80) : null;
  if (!name) return res.status(400).json({ error:"Please enter a display name." });
  if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return res.status(400).json({ error:"Invalid wallet address." });
  db.prepare("UPDATE users SET name=?,wallet_address=? WHERE id=?").run(name,wallet,req.user.id);
  res.json({ ok:true });
});
app.post("/api/purchases", ensureUser, (req,res) => {
  const partner = partners.find(p => p.id === req.body.partnerId);
  const amount = Number(req.body.amount);
  if (!partner) return res.status(400).json({ error:"Choose a valid partner." });
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) return res.status(400).json({ error:"Amount must be between ₹1 and ₹10,00,000." });
  const earned = Math.floor(amount * partner.rate / 100);
  if (earned < 1) return res.status(400).json({ error:"This purchase is too small to earn points." });
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET points=points+?,xp=xp+? WHERE id=?").run(earned,earned,req.user.id);
    db.prepare("INSERT INTO activity(id,user_id,type,title,detail,points,tx_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(makeId("act"),req.user.id,"purchase",`${partner.name} purchase`, `Sample purchase ${amount} INR; earned ${earned} points`,earned,null,"Database recorded",nowIso());
  });
  tx();
  res.json({ ok:true, earned, message:`Purchase recorded; earned ${earned} points. This is a sample purchase, not a payment.` });
});
app.post("/api/vouchers/redeem", ensureUser, (req,res) => {
  const partner = partners.find(p => p.id === req.body.partnerId);
  if (!partner) return res.status(400).json({ error:"Choose a valid partner." });
  const user = db.prepare("SELECT points FROM users WHERE id=?").get(req.user.id);
  if (user.points < partner.cost) return res.status(400).json({ error:`Not enough points. This sample voucher costs ${partner.cost} points.` });
  let code;
  do { code = `PERK-${partner.codePrefix}-${crypto.randomInt(1000,10000)}`; }
  while (db.prepare("SELECT 1 FROM vouchers WHERE code=?").get(code));
  const created = new Date(), expires = new Date(created.getTime()+30*86400000);
  const voucher = { id:makeId("vch"), user_id:req.user.id, partner_id:partner.id, brand:partner.name, discount:partner.discount, code, points_cost:partner.cost, created_at:created.toISOString(), expires_at:expires.toISOString(), status:"active", used_at:null };
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET points=points-? WHERE id=?").run(partner.cost,req.user.id);
    db.prepare("INSERT INTO vouchers(id,user_id,partner_id,brand,discount,code,points_cost,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(voucher.id,voucher.user_id,voucher.partner_id,voucher.brand,voucher.discount,voucher.code,voucher.points_cost,voucher.created_at,voucher.expires_at,voucher.status);
    db.prepare("INSERT INTO activity(id,user_id,type,title,detail,points,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(makeId("act"),req.user.id,"voucher",`${partner.name} voucher redeemed`,`${voucher.discount} · ${voucher.code}`,-partner.cost,"Database recorded",nowIso());
  });
  tx();
  res.status(201).json({ ok:true, voucher, message:"Voucher generated and saved in the database. This sample offer is not redeemable with the brand." });
});
app.post("/api/vouchers/:id/use", ensureUser, (req,res) => {
  const voucher = db.prepare("SELECT * FROM vouchers WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
  if (!voucher) return res.status(404).json({ error:"Voucher not found." });
  if (voucher.status !== "active") return res.status(400).json({ error:"Voucher is already used." });
  if (new Date(voucher.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE vouchers SET status='expired' WHERE id=?").run(voucher.id);
    return res.status(400).json({ error:"Voucher has expired." });
  }
  const usedAt = nowIso();
  const tx = db.transaction(() => {
    db.prepare("UPDATE vouchers SET status='used',used_at=? WHERE id=?").run(usedAt,voucher.id);
    db.prepare("INSERT INTO activity(id,user_id,type,title,detail,points,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(makeId("act"),req.user.id, "used",`${voucher.brand} voucher marked used`,voucher.code,0,"Used in app",usedAt);
  });
  tx();
  res.json({ ok:true, message:"Voucher marked as used in your PerkChain database. This does not redeem it with the brand." });
});
app.post("/api/nfts/mints", ensureUser, (req,res) => {
  const walletAddress=String(req.body.walletAddress||"");
  const txHash=String(req.body.txHash||"");
  const contractAddress=String(req.body.contractAddress||"");
  const tokenId=String(req.body.tokenId||"");
  const network=String(req.body.network||"Sepolia");
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress) || !/^0x[a-fA-F0-9]{64}$/.test(txHash) || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress) || !tokenId) {
    return res.status(400).json({ error:"Wallet, transaction hash, contract address, and token ID must be valid." });
  }
  try {
    db.prepare("INSERT INTO nft_mints(id,user_id,wallet_address,tx_hash,token_id,contract_address,network,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(makeId("mint"),req.user.id,walletAddress,txHash,tokenId,contractAddress,network,nowIso());
    db.prepare("UPDATE users SET wallet_address=? WHERE id=?").run(walletAddress,req.user.id);
    db.prepare("INSERT INTO activity(id,user_id,type,title,detail,points,tx_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(makeId("act"),req.user.id,"nft","Reward NFT minted",`Token #${tokenId} on ${network}`,0,txHash,"On-chain transaction confirmed",nowIso());
    res.status(201).json({ ok:true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error:"This transaction hash is already recorded." });
    console.error(e);res.status(500).json({ error:"Could not save mint record." });
  }
});
app.use("/api", (req,res) => res.status(404).json({ error:"API route not found." }));
app.listen(PORT, () => console.log(`PerkChain running at http://localhost:${PORT}`));
