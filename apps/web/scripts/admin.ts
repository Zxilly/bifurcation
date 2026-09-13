import { eq } from "drizzle-orm";
import { getDatabase } from "../src/server/db";
import { users } from "../src/server/db/schema";
import { issueOnboarding, usernameInput } from "../src/server/identity/service";
import { newId } from "../src/server/crypto";

const [command, rawUsername] = process.argv.slice(2);
const username = usernameInput.parse(rawUsername);
const { db, sqlite } = getDatabase();
try {
  if (command === "init") {
    const result = db.transaction((tx) => {
      if (tx.select().from(users).all().length) throw new Error("数据库已有账号，请使用 admin:recover");
      const id = newId();
      tx.insert(users).values({ id, username, role: "admin", status: "pending", createdAt: Date.now() }).run();
      return issueOnboarding(id, "activation");
    });
    console.log(result.url);
  } else if (command === "recover") {
    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user || user.role !== "admin") throw new Error("管理员账号不存在");
    if (user.status === "disabled") throw new Error("管理员已禁用，不能通过凭据恢复绕过禁用");
    console.log(issueOnboarding(user.id, user.status === "pending" ? "activation" : "recovery").url);
  } else throw new Error("用法：admin:init <username> 或 admin:recover <username>");
} finally { sqlite.close(); }
