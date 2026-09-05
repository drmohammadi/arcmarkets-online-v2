import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Social", () => {
  async function fixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("Social");
    const social = await Factory.deploy();
    await social.waitForDeployment();
    return { social, deployer, alice, bob };
  }

  /** Past the per-author comment cooldown, so consecutive posts are allowed. */
  async function skipCooldown() {
    await time.increase(31);
  }

  // ───────────────────────────── Usernames ─────────────────────────────

  describe("usernames", () => {
    it("stores a name and returns it for that address", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).setUsername("alice");
      expect(await social.usernameOf(alice.address)).to.equal("alice");
    });

    it("returns an empty string for an address that never set one", async () => {
      const { social, bob } = await loadFixture(fixture);
      expect(await social.usernameOf(bob.address)).to.equal("");
    });

    it("preserves the capitalisation the claimer typed", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).setUsername("AliceInArc");
      expect(await social.usernameOf(alice.address)).to.equal("AliceInArc");
    });

    it("rejects a name already held by someone else", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).setUsername("satoshi");
      await expect(
        social.connect(bob).setUsername("satoshi")
      ).to.be.revertedWithCustomError(social, "NameTaken");
    });

    it("treats names differing only in case as the same name", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).setUsername("Alice");
      await expect(
        social.connect(bob).setUsername("alice")
      ).to.be.revertedWithCustomError(social, "NameTaken");
      await expect(
        social.connect(bob).setUsername("ALICE")
      ).to.be.revertedWithCustomError(social, "NameTaken");
    });

    it("lets the holder re-claim their own name to change its capitalisation", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).setUsername("alice");
      await social.connect(alice).setUsername("ALICE");
      expect(await social.usernameOf(alice.address)).to.equal("ALICE");
      expect(await social.holderOf("alice")).to.equal(alice.address);
    });

    it("frees the previous name when renaming, so another address can take it", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).setUsername("first");
      await social.connect(alice).setUsername("second");

      expect(await social.usernameOf(alice.address)).to.equal("second");
      expect(await social.holderOf("first")).to.equal(ethers.ZeroAddress);

      await social.connect(bob).setUsername("first");
      expect(await social.usernameOf(bob.address)).to.equal("first");
    });

    it("counts name limits in BYTES, not characters", async () => {
      const { social, alice } = await loadFixture(fixture);
      // Each of these is 1 character but 3 UTF-8 bytes. Only ASCII is legal
      // anyway, so this must be rejected on charset grounds too.
      await expect(
        social.connect(alice).setUsername("你好吗")
      ).to.be.revertedWithCustomError(social, "InvalidInput");
    });

    it("accepts a name at exactly the minimum and maximum byte length", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).setUsername("abc"); // 3 bytes
      expect(await social.usernameOf(alice.address)).to.equal("abc");

      const max = "a".repeat(20);
      await social.connect(bob).setUsername(max);
      expect(await social.usernameOf(bob.address)).to.equal(max);
    });

    it("rejects a name one byte under the minimum and one over the maximum", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(
        social.connect(alice).setUsername("ab")
      ).to.be.revertedWithCustomError(social, "InvalidInput");
      await expect(
        social.connect(alice).setUsername("a".repeat(21))
      ).to.be.revertedWithCustomError(social, "InvalidInput");
    });

    it("rejects characters outside a-z 0-9 _ and -", async () => {
      const { social, alice } = await loadFixture(fixture);
      for (const bad of ["has space", "dot.dot", "at@sign", "sl/ash", "semi;colon"]) {
        await expect(
          social.connect(alice).setUsername(bad)
        ).to.be.revertedWithCustomError(social, "InvalidInput");
      }
    });

    it("accepts digits, underscores and hyphens", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).setUsername("arc_trader-42");
      expect(await social.usernameOf(alice.address)).to.equal("arc_trader-42");
    });

    it("emits UsernameSet with the display form", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(social.connect(alice).setUsername("Trader1"))
        .to.emit(social, "UsernameSet")
        .withArgs(alice.address, "Trader1");
    });

    it("clears a name, freeing it and emitting", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).setUsername("temp");

      await expect(social.connect(alice).clearUsername())
        .to.emit(social, "UsernameCleared")
        .withArgs(alice.address);

      expect(await social.usernameOf(alice.address)).to.equal("");
      await social.connect(bob).setUsername("temp");
      expect(await social.usernameOf(bob.address)).to.equal("temp");
    });

    it("reverts when clearing a name that was never set", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(
        social.connect(alice).clearUsername()
      ).to.be.revertedWithCustomError(social, "NoUsername");
    });

    it("reports availability without reverting on a malformed name", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      expect(await social.isNameAvailable("free-name", bob.address)).to.equal(true);
      expect(await social.isNameAvailable("no", bob.address)).to.equal(false);
      expect(await social.isNameAvailable("bad char", bob.address)).to.equal(false);

      await social.connect(alice).setUsername("taken");
      expect(await social.isNameAvailable("taken", bob.address)).to.equal(false);
      // The holder sees their own name as available, so a re-case is not blocked.
      expect(await social.isNameAvailable("TAKEN", alice.address)).to.equal(true);
    });

    it("batch-reads names, leaving unset addresses empty", async () => {
      const { social, alice, bob, deployer } = await loadFixture(fixture);
      await social.connect(alice).setUsername("alice");
      const names = await social.usernamesOf([alice.address, bob.address, deployer.address]);
      expect(names[0]).to.equal("alice");
      expect(names[1]).to.equal("");
      expect(names[2]).to.equal("");
    });

    it("rejects a name batch larger than MAX_PAGE", async () => {
      const { social, alice } = await loadFixture(fixture);
      const many = Array.from({ length: 51 }, () => alice.address);
      await expect(social.usernamesOf(many)).to.be.revertedWithCustomError(
        social,
        "PageTooLarge"
      );
    });
  });

  // ───────────────────────────── Comments ──────────────────────────────

  describe("comments", () => {
    const TEXT = "This resolves on the official announcement, not the press leak.";

    it("appends a comment and reads it back", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(5, TEXT);

      expect(await social.commentCount(5)).to.equal(1);
      const page = await social.commentsPaged(5, 0, 10);
      expect(page.length).to.equal(1);
      expect(page[0].author).to.equal(alice.address);
      expect(page[0].text).to.equal(TEXT);
      expect(page[0].deleted).to.equal(false);
      expect(page[0].timestamp).to.be.greaterThan(0);
    });

    it("emits CommentPosted with the thread index", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(social.connect(alice).postComment(2, TEXT))
        .to.emit(social, "CommentPosted")
        .withArgs(2, 0, alice.address, TEXT);
    });

    it("keeps threads separate per questionId", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "on market one");
      await skipCooldown();
      await social.connect(alice).postComment(2, "on market two");

      expect(await social.commentCount(1)).to.equal(1);
      expect(await social.commentCount(2)).to.equal(1);
      const page = await social.commentsPaged(1, 0, 10);
      expect(page[0].text).to.equal("on market one");
    });

    it("accepts a comment for a questionId that does not exist on any factory", async () => {
      // The decoupling property: this registry deliberately does not validate
      // questionIds, which is what lets it serve markets created before it.
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(999999, TEXT);
      expect(await social.commentCount(999999)).to.equal(1);
    });

    it("counts the comment limit in BYTES, not characters", async () => {
      const { social, alice } = await loadFixture(fixture);
      // 100 characters, 300 UTF-8 bytes: passes a character check, must fail here.
      const multibyte = "é".repeat(150); // 2 bytes each = 300 bytes
      await expect(
        social.connect(alice).postComment(1, multibyte)
      ).to.be.revertedWithCustomError(social, "InvalidInput");
    });

    it("accepts a comment at exactly the byte cap and rejects one byte more", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "x".repeat(200));
      expect(await social.commentCount(1)).to.equal(1);

      await expect(
        social.connect(bob).postComment(1, "x".repeat(201))
      ).to.be.revertedWithCustomError(social, "InvalidInput");
    });

    it("rejects an empty comment", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(
        social.connect(alice).postComment(1, "")
      ).to.be.revertedWithCustomError(social, "InvalidInput");
    });

    it("enforces a per-author cooldown between comments", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "first");

      await expect(
        social.connect(alice).postComment(1, "too soon")
      ).to.be.revertedWithCustomError(social, "CooldownActive");

      // The cooldown is per author, so another address is unaffected.
      await social.connect(bob).postComment(1, "not blocked");

      await skipCooldown();
      await social.connect(alice).postComment(1, "allowed now");
      expect(await social.commentCount(1)).to.equal(3);
    });

    it("applies the cooldown across markets, so rotating threads does not bypass it", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "here");
      await expect(
        social.connect(alice).postComment(2, "and here")
      ).to.be.revertedWithCustomError(social, "CooldownActive");
    });

    it("lets the author delete their own comment, keeping the index", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "regrettable");
      await skipCooldown();
      await social.connect(alice).postComment(1, "second");

      await expect(social.connect(alice).deleteComment(1, 0))
        .to.emit(social, "CommentDeleted")
        .withArgs(1, 0);

      // Still two entries: the slot survives so later indices do not shift.
      expect(await social.commentCount(1)).to.equal(2);
      const page = await social.commentsPaged(1, 0, 10);
      expect(page[0].deleted).to.equal(true);
      expect(page[0].text).to.equal("");
      expect(page[1].text).to.equal("second");
    });

    it("lets the owner delete anyone's comment", async () => {
      const { social, deployer, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "spam");
      await social.connect(deployer).deleteComment(1, 0);
      const page = await social.commentsPaged(1, 0, 10);
      expect(page[0].deleted).to.equal(true);
    });

    it("stops an unrelated address from deleting someone else's comment", async () => {
      const { social, alice, bob } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "mine");
      await expect(
        social.connect(bob).deleteComment(1, 0)
      ).to.be.revertedWithCustomError(social, "NotAuthorized");
    });

    it("treats deleting twice as a no-op rather than an error", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, "gone");
      await social.connect(alice).deleteComment(1, 0);
      await social.connect(alice).deleteComment(1, 0);
      const page = await social.commentsPaged(1, 0, 10);
      expect(page[0].deleted).to.equal(true);
    });

    it("reverts when deleting an index that does not exist", async () => {
      const { social, alice } = await loadFixture(fixture);
      await expect(
        social.connect(alice).deleteComment(1, 0)
      ).to.be.revertedWithCustomError(social, "NoSuchComment");
    });

    it("pages a thread oldest-first and truncates at the end", async () => {
      const { social, alice } = await loadFixture(fixture);
      for (let i = 0; i < 5; i++) {
        await social.connect(alice).postComment(1, `comment ${i}`);
        await skipCooldown();
      }

      const first = await social.commentsPaged(1, 0, 2);
      expect(first.length).to.equal(2);
      expect(first[0].text).to.equal("comment 0");
      expect(first[1].text).to.equal("comment 1");

      // A page running past the end comes back short, not reverted.
      const last = await social.commentsPaged(1, 4, 10);
      expect(last.length).to.equal(1);
      expect(last[0].text).to.equal("comment 4");
    });

    it("returns an empty page for an offset past the end or a zero limit", async () => {
      const { social, alice } = await loadFixture(fixture);
      await social.connect(alice).postComment(1, TEXT);
      expect((await social.commentsPaged(1, 99, 10)).length).to.equal(0);
      expect((await social.commentsPaged(1, 0, 0)).length).to.equal(0);
      // An untouched thread reads as empty rather than reverting.
      expect((await social.commentsPaged(42, 0, 10)).length).to.equal(0);
      expect(await social.commentCount(42)).to.equal(0);
    });

    it("rejects a page larger than MAX_PAGE", async () => {
      const { social } = await loadFixture(fixture);
      await expect(social.commentsPaged(1, 0, 51)).to.be.revertedWithCustomError(
        social,
        "PageTooLarge"
      );
    });
  });
});
