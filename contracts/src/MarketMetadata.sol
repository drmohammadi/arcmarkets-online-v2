// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MarketMetadata
/// @notice Off-factory metadata for prediction markets: long description, image
/// URL and resolution source, keyed by the factory's `questionId`.
///
/// @dev WHY A SEPARATE CONTRACT.
/// `MarketFactory` is already deployed, is not upgradeable, and stores only a
/// 256-byte `question` and a 64-byte `category`. Adding fields there would mean
/// redeploying it, which would strand every existing market, pool and open
/// position at the old address. This registry is therefore purely additive: the
/// factory neither knows nor cares that it exists, and metadata can be written
/// for markets that were created long before this contract was deployed.
///
/// @dev DELIBERATELY DECOUPLED.
/// This contract does NOT hold a factory reference and does NOT check that a
/// questionId exists. That is a considered trade: validating would couple the
/// registry to one factory address forever (breaking any future redeploy) and
/// add an external call to every write. Because writes are `onlyOwner` and the
/// UI only ever reads metadata for markets it already enumerated from the
/// factory, an orphan entry is inert.
///
/// @dev TRUST MODEL.
/// `imageUrl` is a URL, not image bytes — on-chain image storage is not viable
/// at this size. The chain cannot verify that a URL points at an image, that it
/// stays reachable, or that its content does not change after it is set. The
/// front end therefore treats it as untrusted: https-only, rendered in a fixed
/// box, with a fallback when it fails to load. Only the owner can set it, which
/// bounds the risk to a trusted role.
contract MarketMetadata is Ownable {
    /// @dev Generous enough for a few paragraphs; bounded so a single write
    /// cannot become unboundedly expensive or unreadable.
    uint256 public constant MAX_DESCRIPTION_BYTES = 2000;
    uint256 public constant MAX_URL_BYTES = 512;
    uint256 public constant MAX_SOURCE_BYTES = 256;

    /// @dev Bounds one batch call so it cannot exceed the block gas limit in a
    /// way that is hard to predict from the UI.
    uint256 public constant MAX_BATCH = 50;

    struct Metadata {
        string description;
        string imageUrl;
        string resolutionSource;
        /// @dev Distinguishes "explicitly set to empty" from "never set", which
        /// the UI needs in order to decide whether to prompt an admin to fill
        /// it in. A default-constructed struct has `set == false`.
        bool set;
    }

    mapping(uint256 => Metadata) private _metadata;

    event MetadataSet(
        uint256 indexed questionId,
        string description,
        string imageUrl,
        string resolutionSource
    );

    event MetadataCleared(uint256 indexed questionId);

    error InvalidInput();
    error LengthMismatch();
    error BatchTooLarge();

    constructor() Ownable(msg.sender) {}

    // ──────────────────────────────── Writes ────────────────────────────────

    /// @notice Set (or overwrite) metadata for one market.
    /// @dev All three strings are validated in BYTES, not characters — the same
    /// convention `MarketFactory` uses. A multi-byte UTF-8 string can pass a
    /// character-count check and still blow the intended budget.
    function setMetadata(
        uint256 questionId,
        string calldata description,
        string calldata imageUrl,
        string calldata resolutionSource
    ) external onlyOwner {
        _set(questionId, description, imageUrl, resolutionSource);
    }

    /// @notice Set metadata for many markets in one transaction.
    /// @dev A multi-outcome "event" in this system is N separate binary markets,
    /// so creating one already costs N transactions. Without this batch, adding
    /// descriptions would double that to 2N signatures.
    function setMetadataBatch(
        uint256[] calldata questionIds,
        string[] calldata descriptions,
        string[] calldata imageUrls,
        string[] calldata resolutionSources
    ) external onlyOwner {
        uint256 n = questionIds.length;
        if (n == 0) revert InvalidInput();
        if (n > MAX_BATCH) revert BatchTooLarge();
        if (
            descriptions.length != n ||
            imageUrls.length != n ||
            resolutionSources.length != n
        ) revert LengthMismatch();

        for (uint256 i = 0; i < n; i++) {
            _set(questionIds[i], descriptions[i], imageUrls[i], resolutionSources[i]);
        }
    }

    /// @notice Remove metadata for a market, returning it to the "never set" state.
    function clearMetadata(uint256 questionId) external onlyOwner {
        delete _metadata[questionId];
        emit MetadataCleared(questionId);
    }

    function _set(
        uint256 questionId,
        string calldata description,
        string calldata imageUrl,
        string calldata resolutionSource
    ) private {
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert InvalidInput();
        if (bytes(imageUrl).length > MAX_URL_BYTES) revert InvalidInput();
        if (bytes(resolutionSource).length > MAX_SOURCE_BYTES) revert InvalidInput();

        _metadata[questionId] = Metadata({
            description: description,
            imageUrl: imageUrl,
            resolutionSource: resolutionSource,
            set: true
        });

        emit MetadataSet(questionId, description, imageUrl, resolutionSource);
    }

    // ──────────────────────────────── Reads ─────────────────────────────────

    /// @notice Read one market's metadata. Unset markets return a zeroed struct
    /// with `set == false` rather than reverting, so the UI can call it for any
    /// market without special-casing.
    function getMetadata(uint256 questionId) external view returns (Metadata memory) {
        return _metadata[questionId];
    }

    /// @notice Batched read for the market list, which needs many at once.
    /// @dev Bounded by MAX_BATCH so a caller cannot force an unbounded loop.
    function getMetadataBatch(uint256[] calldata questionIds)
        external
        view
        returns (Metadata[] memory out)
    {
        uint256 n = questionIds.length;
        if (n > MAX_BATCH) revert BatchTooLarge();
        out = new Metadata[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _metadata[questionIds[i]];
        }
    }
}
