// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Social
/// @notice User-authored content for the prediction market: a globally unique
/// display name per address, and a comment thread per market `questionId`.
///
/// @dev WHY A SEPARATE CONTRACT.
/// Same reasoning as `MarketMetadata`: `MarketFactory` is already deployed, is
/// not upgradeable, and stores nothing about users. This registry is purely
/// additive — the factory neither knows nor cares that it exists, and comments
/// can be written for markets created long before this contract was deployed.
///
/// @dev WHY ON-CHAIN AT ALL.
/// The front end is a static site with no backend and no database, so any
/// browser-local store (the pattern used for hidden markets) would make a
/// comment visible only to its own author and a username visible only to the
/// person who chose it. That is not a comments section. Putting both on-chain
/// is what makes them shared.
///
/// @dev HOW THIS DIFFERS FROM MarketMetadata: PERMISSIONLESS WRITES.
/// Every write in `MarketMetadata` is `onlyOwner`, so its only real bound is a
/// byte cap. Here ANY address may write, which changes the threat model:
///   - Every string is attacker-controlled. Callers must treat all output as
///     hostile; the front end already routes chain strings through
///     `lib/sanitize.ts`, which strips controls, zero-width and bidi-override
///     characters.
///   - Names are restricted to an unambiguous charset ON CHAIN (see
///     `_normalizeName`), not merely in the UI. Uniqueness enforced against a
///     display form would be cosmetic: a client could claim a visually
///     identical name using different bytes.
///   - Comments carry a per-author cooldown so a single address cannot flood a
///     thread as fast as it can send transactions.
/// Gas is the backstop for everything else: griefing costs real value per call.
///
/// @dev WHY COMMENTS ARE STORED, NOT EVENT-ONLY.
/// Emitting a comment as an event alone would be markedly cheaper, but events
/// are only readable through a bounded `getLogs` window. Older comments would
/// silently disappear from the thread as the chain advanced, which reads as
/// data loss. Storage plus paged reads makes the thread exact and costs the
/// reader no log scan at all. Events are ALSO emitted, for indexers.
contract Social is Ownable {
    // ─────────────────────────────── Usernames ──────────────────────────────

    /// @dev Long enough to be meaningful, short enough to render in a table row
    /// and a leaderboard without truncation.
    uint256 public constant MIN_NAME_BYTES = 3;
    uint256 public constant MAX_NAME_BYTES = 20;

    /// @dev Display form, exactly as the claimer typed it (case preserved).
    mapping(address => string) private _username;

    /// @dev keccak256 of the NORMALIZED (lowercased) name => current holder.
    /// Separate from the display form so "Alice" and "alice" cannot both exist
    /// while the UI still shows the capitalisation the owner chose.
    mapping(bytes32 => address) private _nameHolder;

    // ─────────────────────────────── Comments ───────────────────────────────

    /// @dev Mirrors the 200-character cap the UI advertises. Checked in BYTES,
    /// the same convention `MarketFactory` and `MarketMetadata` use: a
    /// multi-byte UTF-8 string passes a character count and still blows the
    /// intended storage budget.
    uint256 public constant MAX_COMMENT_BYTES = 200;

    /// @dev Minimum seconds between comments from one address. Deliberately
    /// small: this is friction against flooding, not a rate limit on discussion.
    uint256 public constant COMMENT_COOLDOWN = 30;

    /// @dev Bounds one paged read so a caller cannot force an unbounded loop.
    uint256 public constant MAX_PAGE = 50;

    struct Comment {
        address author;
        /// @dev block.timestamp at post time. Safe until year 584942417355.
        uint64 timestamp;
        /// @dev Soft delete. The entry keeps its slot so indices stay stable
        /// for anyone who linked to or cached one; a hard removal would
        /// silently re-point every later index.
        bool deleted;
        string text;
    }

    mapping(uint256 => Comment[]) private _comments;

    /// @dev Last post time per author, across all markets. Global rather than
    /// per-market so a flooder cannot simply rotate threads.
    mapping(address => uint256) public lastCommentAt;

    event UsernameSet(address indexed user, string name);
    event UsernameCleared(address indexed user);
    event CommentPosted(
        uint256 indexed questionId,
        uint256 indexed index,
        address indexed author,
        string text
    );
    event CommentDeleted(uint256 indexed questionId, uint256 indexed index);

    error InvalidInput();
    error NameTaken();
    error NoUsername();
    error CooldownActive(uint256 nextPostTime);
    error NotAuthorized();
    error NoSuchComment();
    error PageTooLarge();

    constructor() Ownable(msg.sender) {}

    // ──────────────────────────── Username writes ───────────────────────────

    /// @notice Claim a display name. Frees the caller's previous name, if any.
    /// @dev Reverts with `NameTaken` when another address holds the normalized
    /// form. Re-claiming a name you already hold is allowed and simply updates
    /// the stored capitalisation.
    function setUsername(string calldata name) external {
        bytes32 key = _normalizeName(name);

        address holder = _nameHolder[key];
        if (holder != address(0) && holder != msg.sender) revert NameTaken();

        // Release the old name before taking the new one, so a rename does not
        // leave the previous key pointing at this address forever.
        // Copied into memory first: `bytes(...)` converts a `string memory`, not
        // a storage reference.
        string memory prev = _username[msg.sender];
        if (bytes(prev).length > 0) {
            bytes32 prevKey = _normalizeName(prev);
            if (prevKey != key) delete _nameHolder[prevKey];
        }

        _nameHolder[key] = msg.sender;
        _username[msg.sender] = name;

        emit UsernameSet(msg.sender, name);
    }

    /// @notice Give up the caller's name, returning them to the default the UI
    /// derives from their address.
    function clearUsername() external {
        string memory prev = _username[msg.sender];
        if (bytes(prev).length == 0) revert NoUsername();

        delete _nameHolder[_normalizeName(prev)];
        delete _username[msg.sender];

        emit UsernameCleared(msg.sender);
    }

    /// @dev Validate and lowercase a name, returning its uniqueness key.
    /// Reverts on anything malformed. Thin wrapper over `_tryNormalize` so the
    /// claiming path and the live-validation path can never disagree about what
    /// a legal name is.
    function _normalizeName(string memory name) private pure returns (bytes32) {
        (bool ok, bytes32 key) = _tryNormalize(name);
        if (!ok) revert InvalidInput();
        return key;
    }

    /// @dev The single definition of a legal name: ASCII `a-z`, `A-Z`, `0-9`,
    /// `_` and `-`, between MIN_NAME_BYTES and MAX_NAME_BYTES.
    ///
    /// Restricting the charset ON CHAIN is what makes uniqueness meaningful.
    /// Allowing arbitrary UTF-8 would let a caller register a homoglyph of an
    /// existing name — visually identical, different bytes, different key — and
    /// impersonate its holder on the leaderboard. Enforcing it here keeps the
    /// guarantee even for callers that never touch our UI.
    ///
    /// Writes into a FRESH buffer rather than folding case in place. `bytes(s)`
    /// on a `string memory` is a cast, not a copy, so mutating it would also
    /// mutate the caller's string — an aliasing bug that would silently store
    /// lowercased display names.
    function _tryNormalize(string memory name) private pure returns (bool, bytes32) {
        bytes memory b = bytes(name);
        if (b.length < MIN_NAME_BYTES || b.length > MAX_NAME_BYTES) return (false, bytes32(0));

        bytes memory folded = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            bool lower = c >= 0x61 && c <= 0x7a; // a-z
            bool upper = c >= 0x41 && c <= 0x5a; // A-Z
            bool digit = c >= 0x30 && c <= 0x39; // 0-9
            bool punct = c == 0x5f || c == 0x2d; // _ -
            if (!(lower || upper || digit || punct)) return (false, bytes32(0));
            folded[i] = upper ? bytes1(c + 32) : bytes1(c);
        }

        return (true, keccak256(folded));
    }

    // ──────────────────────────── Username reads ────────────────────────────

    /// @notice The display name for an address, or "" when unset. Never reverts,
    /// so the UI can call it for any address and fall back to its derived
    /// default without special-casing.
    function usernameOf(address user) external view returns (string memory) {
        return _username[user];
    }

    /// @notice Batched names, for the leaderboard and a comment thread.
    /// @dev Bounded by MAX_PAGE so a caller cannot force an unbounded loop.
    function usernamesOf(address[] calldata users)
        external
        view
        returns (string[] memory out)
    {
        uint256 n = users.length;
        if (n > MAX_PAGE) revert PageTooLarge();
        out = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _username[users[i]];
        }
    }

    /// @notice Whether a name could be claimed by `who`.
    /// @dev Returns false for a malformed name rather than reverting, so the UI
    /// can call it for live validation on every keystroke. Shares
    /// `_tryNormalize` with the write path, so "available" here and "accepted"
    /// by `setUsername` can never drift apart.
    function isNameAvailable(string calldata name, address who) external view returns (bool) {
        (bool ok, bytes32 key) = _tryNormalize(name);
        if (!ok) return false;
        address holder = _nameHolder[key];
        return holder == address(0) || holder == who;
    }

    /// @notice The address holding a name, or the zero address.
    function holderOf(string calldata name) external view returns (address) {
        return _nameHolder[_normalizeName(name)];
    }

    // ──────────────────────────── Comment writes ────────────────────────────

    /// @notice Append a comment to a market's thread.
    /// @dev Like `MarketMetadata`, this does NOT check that `questionId` refers
    /// to a real market — validating would couple this contract to one factory
    /// address forever. An orphan thread is inert: the UI only ever reads
    /// threads for markets it already enumerated from the factory.
    function postComment(uint256 questionId, string calldata text) external {
        uint256 len = bytes(text).length;
        if (len == 0 || len > MAX_COMMENT_BYTES) revert InvalidInput();

        uint256 nextAllowed = lastCommentAt[msg.sender] + COMMENT_COOLDOWN;
        if (block.timestamp < nextAllowed) revert CooldownActive(nextAllowed);
        lastCommentAt[msg.sender] = block.timestamp;

        uint256 index = _comments[questionId].length;
        _comments[questionId].push(
            Comment({
                author: msg.sender,
                timestamp: uint64(block.timestamp),
                deleted: false,
                text: text
            })
        );

        emit CommentPosted(questionId, index, msg.sender, text);
    }

    /// @notice Remove a comment. Callable by its author or by the owner, the
    /// latter so abusive content can be taken down without a redeploy.
    function deleteComment(uint256 questionId, uint256 index) external {
        Comment[] storage thread = _comments[questionId];
        if (index >= thread.length) revert NoSuchComment();

        Comment storage c = thread[index];
        if (msg.sender != c.author && msg.sender != owner()) revert NotAuthorized();
        if (c.deleted) return; // Idempotent: deleting twice is not an error.

        c.deleted = true;
        // Free the text slot; the entry itself stays so indices remain stable.
        c.text = "";

        emit CommentDeleted(questionId, index);
    }

    // ───────────────────────────── Comment reads ────────────────────────────

    /// @notice Number of entries in a thread, INCLUDING deleted ones.
    /// @dev Deleted entries are counted because they still occupy an index;
    /// a pager that skipped them would walk off the end.
    function commentCount(uint256 questionId) external view returns (uint256) {
        return _comments[questionId].length;
    }

    /// @notice A page of a thread, oldest-first from `offset`.
    /// @dev Returns a short (possibly empty) array when the page runs past the
    /// end, rather than reverting, so a caller racing a new post cannot error.
    function commentsPaged(uint256 questionId, uint256 offset, uint256 limit)
        external
        view
        returns (Comment[] memory out)
    {
        if (limit > MAX_PAGE) revert PageTooLarge();

        Comment[] storage thread = _comments[questionId];
        uint256 total = thread.length;
        if (offset >= total || limit == 0) return new Comment[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 n = end - offset;

        out = new Comment[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = thread[offset + i];
        }
    }
}
