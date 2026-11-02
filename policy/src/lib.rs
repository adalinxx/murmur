//! Transaction-scope validity policy for Murmur, short posts on Lattice.
//!
//! Every key belongs to one account, which must sign to write or delete it:
//!
//! - `post/<a>/<id>`: a post by `<a>`. Created once, deleted, never edited,
//!   so a reply or a like always points at what its author saw. At most
//!   `MAX_VALUE` bytes: the media a post shows are named by CID, the bytes
//!   kept off the chain.
//! - `profile/<a>`: `<a>`'s card. At most `MAX_VALUE` bytes.
//! - `reply/`, `repost/` or `quote/<author>/<id>/<a>/<rid>`: `<a>`'s post
//!   `<rid>` replies to, reposts or quotes post `<id>` by `<author>`, listed
//!   from the post it points at. Value `1`.
//! - `like/<a>/<author>/<id>` and its twin `liked/<author>/<id>/<a>`: written
//!   directly after it, to the same value, `1`, or deleted with it. The chain
//!   starts with neither, so the two always agree.
//!
//! What a post says, and whether a post listed under another really points at
//! it, is for readers: the policy never reads JSON.
//!
//! `<a>` and `<author>` are account addresses; `<id>` is 1 to `MAX_ID`
//! lowercase letters and digits. Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{is_address, transaction_body, Action, Body, Signers};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The most bytes a post or a card holds: room for 280 characters of any
/// script, a reply's target, and four pictures' CIDs with their alt text, and
/// no more, since every byte is kept by every host for good.
pub const MAX_VALUE: usize = 4096;
/// The longest post id: a time in base 36 and a few random characters.
pub const MAX_ID: usize = 16;

/// The verdict for one policy context, with `scratch` for the signer tree.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    transaction_body(context).and_then(|body| check_body(body, scratch)).is_some()
}

/// What a key is, read from its segments.
#[derive(PartialEq)]
enum Record<'a> {
    Post { account: &'a [u8] },
    Profile { account: &'a [u8] },
    /// A post by `account` listed under the post it replies to, reposts or quotes.
    Pointer { account: &'a [u8] },
    /// `like/`: `account` likes post `id` by `author`.
    Like { account: &'a [u8], author: &'a [u8], id: &'a [u8] },
    /// `liked/`: the like's twin, listed from the post.
    Liked { account: &'a [u8], author: &'a [u8], id: &'a [u8] },
}

fn check_body(bytes: &[u8], scratch: &mut [u32]) -> Option<()> {
    let body = Body::parse(bytes)?;
    let signers = body.signers(scratch)?;
    let mut actions = body.actions()?;
    while let Some(action) = actions.next() {
        let action = action?;
        match parse(action.key)? {
            Record::Post { account } => {
                signs(&signers, account)?;
                // Created, or deleted; never edited.
                match (action.old_value, action.new_value) {
                    (None, Some(value)) => sized(value)?,
                    (Some(_), None) => {}
                    _ => return None,
                }
            }
            Record::Profile { account } => {
                signs(&signers, account)?;
                if let Some(value) = action.new_value {
                    sized(value)?;
                }
            }
            Record::Pointer { account } => {
                signs(&signers, account)?;
                marker(&action)?;
            }
            Record::Like { account, author, id } => {
                signs(&signers, account)?;
                marker(&action)?;
                let twin = actions.next()??;
                let same = parse(twin.key)? == Record::Liked { account, author, id } && twin.new_value == action.new_value;
                same.then_some(())?;
            }
            // A twin only ever comes right after its first key, read above.
            Record::Liked { .. } => return None,
        }
    }
    Some(())
}

fn signs(signers: &Signers, account: &[u8]) -> Option<()> {
    signers.is_signer(account)
}

/// A post or card: something, and not too much.
fn sized(value: &[u8]) -> Option<()> {
    (!value.is_empty() && value.len() <= MAX_VALUE).then_some(())
}

/// An index entry's value: `1`, or deleted.
fn marker(action: &Action) -> Option<()> {
    matches!(action.new_value, None | Some(b"1")).then_some(())
}

fn parse(key: &[u8]) -> Option<Record<'_>> {
    let mut segments = key.split(|&byte| byte == b'/');
    let kind = segments.next()?;
    let mut next = || segments.next();
    let record = match kind {
        b"post" => {
            let (account, id) = (next()?, next()?);
            (is_address(account) && is_id(id)).then_some(Record::Post { account })?
        }
        b"profile" => {
            let account = next()?;
            is_address(account).then_some(Record::Profile { account })?
        }
        b"reply" | b"repost" | b"quote" => {
            let (author, id, account, rid) = (next()?, next()?, next()?, next()?);
            (is_address(author) && is_id(id) && is_address(account) && is_id(rid)).then_some(Record::Pointer { account })?
        }
        b"like" => {
            let (account, author, id) = (next()?, next()?, next()?);
            (is_address(account) && is_address(author) && is_id(id)).then_some(Record::Like { account, author, id })?
        }
        b"liked" => {
            let (author, id, account) = (next()?, next()?, next()?);
            (is_address(account) && is_address(author) && is_id(id)).then_some(Record::Liked { account, author, id })?
        }
        _ => return None,
    };
    next().is_none().then_some(record)
}

/// A post id: 1 to `MAX_ID` lowercase letters and digits.
fn is_id(text: &[u8]) -> bool {
    (1..=MAX_ID).contains(&text.len()) && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9'))
}
