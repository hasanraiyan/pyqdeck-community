import { BaseRepository } from "../../core/base/BaseRepository.js";
import { UserModel, type IUser } from "./user.model.js";

export class UserRepository extends BaseRepository<IUser> {
  constructor() {
    super(UserModel);
  }

  findByClerkId(clerkId: string) {
    return this.findOne({ clerkId });
  }

  findByUsername(username: string) {
    return this.findOne({ username: username.toLowerCase() });
  }

  async isUsernameTaken(username: string) {
    return (await this.exists({ username })) !== null;
  }

  updateByClerkId(clerkId: string, update: Partial<IUser>) {
    return this.model.findOneAndUpdate({ clerkId }, update, { new: true, runValidators: true }).exec();
  }
}
