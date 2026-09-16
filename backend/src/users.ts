import { ApiError, type Profile, type Store } from "./core.js";
export class Users {
  constructor(private store: Store) {}
  async claim(uid: string, name: string, displayName: string) {
    return this.store.transaction(async (tx) => {
      const owner = await tx.get<{ uid: string }>(`usernames/${name}`);
      const old = await tx.get<Profile>(`users/${uid}`);
      if (owner && owner.uid !== uid) throw new ApiError(409, "username_taken");
      const p: Profile = {
        uid,
        username: name,
        displayName: displayName || name,
      };
      if (old && old.username !== name) tx.delete(`usernames/${old.username}`);
      tx.set(`usernames/${name}`, { uid });
      tx.set(`users/${uid}`, p);
      return p;
    });
  }
  async search(name: string) {
    const p = await this.store.get<{ uid: string }>(`usernames/${name}`);
    return p ? await this.store.get<Profile>(`users/${p.uid}`) : null;
  }
}
