# Mapping your folders — what ctxEco reads

You are about to let ctxEco **map** part of your cloud storage. Mapping reads
the structure of your folders and the details your storage system already keeps
about each item. It does not open your documents.

Please read this before you agree. We store the exact words on this page
alongside your decision, so that later there is no argument about what you were
told.

## What we read

For every folder and file inside the area you choose, including everything
nested inside it:

- the **name** of the file or folder
- its **full path** — every folder name on the way to it
- its **size** and its **file type**
- the **dates** it was created and last changed
- who **owns** it and who **created** it
- who **last changed** it
- the **sharing and permission structure** around it: which people, groups,
  applications, domains and sharing links have been granted access, and in what
  role
- the identifiers your storage system uses for the item, for the drive it sits
  on, and for the site it belongs to

## What we do not read

We do not open, download, or read the contents of any document. Not the text,
not the images inside it, not a preview, not a thumbnail, not an extracted
summary. Nothing from inside a file is fetched and nothing from inside a file is
indexed.

Reading contents is a different thing. It is called ingest, it has its own
disclosure, and it requires your consent separately.

## This is not a privacy feature

We want to be blunt about this, because the opposite claim is the easy one to
make and we are not going to make it.

Names and paths are not harmless. One path can tell you more than the document
it points at:

    /Legal/Litigation/Smith v Acme/Settlement Draft.docx

Nobody opened that file, and you already know there is a dispute, who it is
with, which side is being advised, and that a settlement is being drafted. A
folder named `Oncology`, or a file named `Performance Review - <name> 2025.docx`,
work the same way. Paths are written by people to be meaningful, which makes
them almost pure signal with no filler.

So the honest claim is not that this is safe because it is only metadata. The
honest claim is: **we read less, and we tell you precisely what we read.**

## Sharing structure is information in its own right

Who has access to what says something on its own. A map shows which people work
on the same material, which outside domains have been let in, and where an open
sharing link is exposing a folder. Finding that last one is often the reason to
build a map at all — but it is worth saying plainly that a map of sharing is
also a map of who works with whom, and you may not have expected a filing tool
to work that out.

## Who can see the map afterwards

The connection is made with your account, so ctxEco can only read what you can
already see in your storage. That is a limit on what gets read. **It is not, by
itself, a limit on who can see it afterwards.**

The map becomes part of your ctxEco workspace. Other people in that workspace
may be able to reach what it contains — folder names, paths, who worked on what
— through search and through answers, even if they could not open the original
folder in your storage. You can narrow that with your workspace's own access
controls, but it is not narrow by default. Please do not map an area you would
not be willing to describe to your colleagues.

## Using the map means sending parts of it to an inference service

The map is stored in your ctxEco workspace. But when it is used to answer a
question, the parts of it that answer that question — folder names, paths, the
names of the people who worked on something — are sent to the inference service
configured for your workspace, exactly as document text would be. Your
workspace's configuration determines which service that is and where it runs.

We say this here, and not only in the disclosure about reading document
contents, because a path is often more revealing than the document it points at.
"It is only metadata" is not a reason to disclose this less carefully.

## Other people's files may be in your folders

Personal and shared drives usually hold material other people sent you, or that
other people own, or that belongs to a client. Choosing an area to map is a
decision about their names and their filing as well as yours, and it is often
not yours alone to make. Choose the narrowest area that is actually useful.

## What this permission covers

Only the area named in this consent record, and everything nested inside it.
Anything recorded here as an exclusion is not mapped. This permission does not
extend to any other site, drive or folder — each of those needs its own consent
and its own record.

## We never change anything in your storage

Mapping is read-only. ctxEco does not create, rename, move, overwrite or delete
anything in your storage while mapping. It never deletes one of your files — not
in this feature, not anywhere else in this product, under any setting.

## Withdrawing this permission

You can withdraw this permission at any time, from your connector settings.

Withdrawing is recorded as a **new, separate event**. The record of your
original decision is never altered and never deleted, so the history of what was
permitted, by whom, and when stays intact and can be examined later. We do not
map under a permission that has been withdrawn.

**Withdrawing does not, by itself, erase a map that was already built.** We say
that plainly because the comfortable version of the sentence would not be true.
Removing a map that already exists is a separate action; withdrawing your
permission is not that action and does not perform it. If you want a map
removed, ask us and we will remove it.

Nothing here touches your storage. Granting this permission, withdrawing it, and
removing a map afterwards all leave your folders and files exactly as they are.

## What we do not do with it

We do not sell it. We do not share it with other ctxEco customers — your
workspace is isolated from every other workspace. Neither ctxEco nor the model
providers ctxEco uses train models on it.
