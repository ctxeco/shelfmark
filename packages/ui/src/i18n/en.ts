// SPDX-License-Identifier: Apache-2.0
import type { MessageDict } from './types.js';

export const en: MessageDict = {
  'labels.commercial': 'commercial',
  'labels.unclassified': 'unclassified',
  'labels.ear_restricted': 'ear restricted',
  'labels.itar_restricted': 'itar restricted',
  'labels.sovereign': 'sovereign',
  'labels.government': 'government',
  'connectors.navLink': 'Connectors',
  'connectors.title': 'Document connectors',
  'connectors.listError': 'Unable to load connectors',
  'connectors.rootLabel': 'Root',
  'connectors.connectError': 'Unable to start connection',
  'connectors.browseError': 'Unable to browse folders',
  'connectors.syncError': 'Unable to start sync',
  'connectors.disconnectError': 'Unable to disconnect',
  'connectors.connectTitle': 'Connect a source',
  'connectors.connectSubtitle': 'Ingest documents from OneDrive or SharePoint, including nested folders.',
  'connectors.connecting': 'Connecting\u2026',
  'connectors.connectOneDrive': 'Connect OneDrive',
  'connectors.connectSharePoint': 'Connect SharePoint',
  'connectors.loading': 'Loading connectors\u2026',
  'connectors.empty': 'No connectors yet \u2014 connect a source above to get started.',
  'connectors.noRootYet': 'No folder selected yet',
  'connectors.status.connected': 'Connected',
  'connectors.status.syncing': 'Syncing',
  'connectors.status.error': 'Error',
  'connectors.status.disconnected': 'Disconnected',
  'connectors.changeRoot': 'Change folder',
  'connectors.pickRoot': 'Pick a folder',
  'connectors.disconnect': 'Disconnect',
  'connectors.browsing': 'Loading folders\u2026',
  'connectors.startingSync': 'Starting\u2026',
  'connectors.cancel': 'Cancel',
  'connectors.oauthHandoff.title': '{grantor} will ask for permission next',
  'connectors.oauthHandoff.body':
    'That screen is theirs, not ours. It grants read access to your drive \u2014 we still will not open any of your files until you say so.',
  'connectors.oauthHandoff.continue': 'Continue to {grantor}',
  'connectors.oauthHandoff.cancel': 'Not now',
  'connectors.grantor.microsoft': 'Microsoft',
  'connectors.browseScopeHint':
    'We could not open that folder. Microsoft answers "not found" both for a folder that is gone and for one this connection was never given permission to see, so the two look identical from here. Disconnect this drive, connect it again, and accept every permission on their screen. If it still fails, the folder has been moved or deleted.',
  'connectors.browseScopeMissingHint':
    'This connection was never granted permission to read that folder. Disconnect this drive, connect it again, and accept every permission on the provider\u2019s screen.',
  'connectors.browseFolderNotFoundHint':
    'That folder is no longer there \u2014 it was moved, renamed or deleted in your drive. Your connection is fine; go back up and pick a folder that still exists.',
  'connectors.browseDisconnectedHint':
    'This drive is disconnected, so there is nothing to list. Connect it again to browse it.',
  'connectors.browseDisabledHint':
    'Drive connectors are switched off for this workspace. An administrator can turn them back on.',
  'connectors.browseThrottledHint':
    'Your drive provider asked us to slow down. Wait about {seconds} seconds, then load the rest \u2014 nothing already listed has been lost.',
  'connectors.browseThrottledHintNoDelay':
    'Your drive provider asked us to slow down. Wait a moment, then load the rest \u2014 nothing already listed has been lost.',
  'connectors.browseThrottledRetryHint':
    'Your drive provider asked us to slow down. Wait about {seconds} seconds, then try again.',
  'connectors.browseThrottledRetryHintNoDelay':
    'Your drive provider asked us to slow down. Wait a moment, then try again.',
  'connectors.browseFailedHint':
    'We could not list that folder. Try again \u2014 and if it keeps failing, disconnect this drive and connect it again.',
  'connectors.browseUnreadableHint':
    'Your drive answered, but the answer was not something we could read \u2014 so we do not know what is in this folder. That is a failure on our side, not an empty folder. Try again.',
  'connectors.browseSignedOutHint':
    'Your sign-in has expired, so we could not check this request. Sign in again and come back to this folder. Your drive connection is untouched \u2014 and reconnecting it would not help, because that needs a valid sign-in to finish.',
  'connectors.browsePolicyDeniedHint':
    'Your workspace security policy blocked this request. The drive connection is not the problem, so reconnecting it would change nothing \u2014 ask an administrator to check the policy for this workspace.',
  'connectors.browseConnectionGoneHint':
    'This drive connection is not available to your workspace any more \u2014 it was removed, or it was never yours to browse. Nothing here needs disconnecting: reload this page and the list will show the connections that actually exist.',
  'connectors.browseServerErrorHint':
    'Something on our side failed while listing this folder. Your drive and your connection are fine \u2014 try again in a moment, and if it keeps failing that is ours to fix, not something a reconnection will cure.',
  'connectors.browseUnexpectedHint':
    'We could not list that folder, and the reason we got back is not one we recognise. Try again \u2014 and do not disconnect the drive over this; if it keeps happening, tell us when it happened.',
  'connectors.browseRetry': 'Try again',
  'connectors.sharepointSite.prompt':
    'SharePoint holds many sites, and your sign-in does not say which one you mean. Paste it from the address bar of the SharePoint site you want.',
  'connectors.sharepointSite.hostnameLabel': 'SharePoint address',
  'connectors.sharepointSite.hostnamePlaceholder': 'contoso.sharepoint.com',
  'connectors.sharepointSite.pathLabel': 'Site path',
  'connectors.sharepointSite.pathPlaceholder': '/sites/Finance',
  'connectors.sharepointSite.submit': 'Open this site',
  'connectors.browse.folderEmpty': 'This folder is empty.',
  'connectors.browse.complete': 'All {n} items in this folder.',
  'connectors.browse.partial': '{n} items so far. This folder has more \u2014 this list is NOT complete.',
  'connectors.browse.partialNone':
    'Nothing listed yet, and there is more of this folder still to read \u2014 this list is NOT complete.',
  'connectors.browse.incompleteUnknown':
    'Listing this folder stopped early, so what you see here may not be all of it.',
  'connectors.browse.loadMore': 'Load the rest',
  'connectors.browse.loadingMore': 'Loading more\u2026',
  'connectors.browse.sizeUnknown': 'size not reported',
  'connectors.browse.modifiedUnknown': 'date not reported',
  'connectors.browse.emptyMarker': 'empty',
  'connectors.browse.childCount': '{n} items',
  'connectors.browse.childCountUnknown': 'item count not reported',
  'connectors.browse.folderRowLabel': 'Folder',
  'connectors.browse.fileRowLabel': 'File',
  'connectors.clearanceCarriedNote':
    'This folder is filed as {clearance} for now. Classification is a decision about what is inside these files, and nothing has been read yet \u2014 you set it once the map shows you.',
  'map.pickRoot.cta': 'Map this folder',
  'map.pickRoot.ctaSubtitle': 'We will list what is in here. We will not open it.',
  'map.title': 'Drive map',
  'map.back': 'Back to connectors',
  'map.resolving': 'Checking this connection…',
  'map.resolveError': 'Could not check the state of this map right now.',
  'map.resolveRetry': 'Try again',
  'mapConsent.title': 'Read the names, not the files.',
  'mapConsent.honesty':
    'A folder called “Divorce 2019” tells us something even if it is empty. Reading names is less than reading files — it is not nothing.',
  'mapConsent.scopeLine': 'Covers {folder} and everything inside it.',
  'mapConsent.scopeLineUnknown':
    'We could not confirm which folder this connection is set to. The map will cover the folder configured for this connection — reload to see it named before you decide.',
  'mapConsent.cta': 'Map this folder — read names only',
  'mapConsent.granting': 'Recording your consent…',
  'mapConsent.starting': 'Starting the map…',
  'mapConsent.retryStart': 'Start the map again',
  'mapConsent.alreadyConsented':
    'Map consent is already on record for this connection — granted {date}. Starting another map will not ask again; revoking the consent is what withdraws it.',
  'mapConsent.disclosureTitle': 'The exact words on record',
  'mapConsent.disclosureSha': 'SHA-256 {sha}',
  'mapConsent.disclosureLoading': 'Fetching the consent text…',
  'mapConsent.disclosureError': 'The consent text could not be fetched, so nothing can be consented to yet.',
  'mapConsent.disclosureRetry': 'Fetch it again',
  'mapConsent.staleDisclosure':
    'The consent text changed while this page was open. Nothing was recorded. The current version is below — read it before continuing.',
  'mapConsent.mappingDisabled':
    'An administrator has mapping switched off for this workspace. No map can start until it is switched back on.',
  'mapConsent.connectorsDisabled':
    'An administrator has connectors switched off for this workspace. No map can start until they are switched back on.',
  'mapConsent.consentNotActive':
    'The server has no active map consent for this connection — it may have just been revoked. Read the text below and consent again if you still want the map.',
  'mapConsent.grantFailed': 'Your consent was not recorded, so nothing was started. Try again.',
  'mapConsent.startFailed':
    'Your consent is on record. Starting the map itself failed — try again below; you will not be asked to consent twice.',
  'mapConsent.connectionGone': 'This connection no longer exists. Go back to connectors and reconnect a drive.',
  'mapConsent.vs.caption': 'The two verbs, side by side',
  'mapConsent.vs.mapCol': 'Map — this consent',
  'mapConsent.vs.ingestCol': 'Ingest — a later, separate consent',
  'mapConsent.vs.rowOpened': 'Files opened',
  'mapConsent.vs.ingestOpenedUnknown': 'every file you approve then — counted at that step',
  'mapConsent.vs.rowRead': 'What we read',
  'mapConsent.vs.readMap': 'names, sizes, dates, permissions',
  'mapConsent.vs.readIngest': 'the words inside',
  'mapConsent.vs.rowLeaves': 'What leaves your workspace',
  'mapConsent.vs.leavesMap': 'names and counts, to the inference service',
  'mapConsent.vs.leavesIngest': 'document text, to the inference service',
  'mapConsent.vs.rowReversible': 'Reversible',
  'mapConsent.vs.reversibleMap': 'yes — delete the map',
  'mapConsent.vs.reversibleIngest': 'yes — but embeddings are rebuilt, not un-read',
  'map.stage.mappingTitle': 'The map is running.',
  'map.stage.mappingBody': 'Reading names, sizes, dates and folder structure — opening nothing.',
  'map.stage.completeTitle': 'The map is complete.',
  'map.stage.completeSummary': '{items} items listed across {folders} folders. No file was opened.',
  'map.stage.completeNoCounts': 'The run finished. No file was opened.',
  'map.stage.failedTitle': 'The map failed.',
  'map.stage.failedBody':
    'The map stopped before finishing. What it listed before failing is recorded; no file was opened.',
  'map.stream.header': 'live narration',
  'map.stream.replay': 'Replay',
  'map.stream.tierNone': 'no model',
  'map.stream.waitingFirstLine': 'Waiting for the first line…',
  'map.stream.capNotice':
    'Showing the last {shown} of {total} lines — earlier lines have rolled off this view. The full narration stays on the record.',
  'map.stream.fallbackNotice':
    'The live stream could not stay open, so this page checks progress every few seconds instead. Nothing is lost — the narration catches up on each check.',
  'map.stream.progressCounts': '{items} items listed · {folders} folders walked',
  'map.stream.progressPath': 'reading names in {path}',
  'map.stream.kindSum': 'arithmetic',
  'map.stream.kindChk': 'check',
  'map.stream.kindAsk': 'model asked',
  'map.stream.kindFix': 'correction',
  'map.stream.failedTranscript': 'The narration above is the record of how far it got. It stays.',
  'map.refused.noConsentTitle': 'The map stopped: consent was revoked.',
  'map.refused.noConsentBody':
    'Map consent was revoked while this run was underway, so it stopped where it stood. Nothing further was read.',
  'map.refused.partialProgress':
    'Before stopping, it had listed {items} items across {folders} folders. That partial record remains.',
  'map.refused.unsupportedTitle': 'This drive cannot be mapped yet.',
  'map.refused.unsupportedBody': 'Mapping is not available for this provider yet. Nothing was read.',
  'map.landed.noFiles':
    'The map listed no files under this folder. The folder structure below is still the record.',
  'map.landed.headline': 'Knowledge — your documents and source — is {filesPct}% of your files and {bytesPct}% of your bytes.',
  'map.landed.byBytes': 'By bytes — what storage bills you for',
  'map.landed.byFiles': 'By file count — what a person calls “my files”',
  'map.landed.encodingGroup': 'Encoding',
  'map.landed.toggleBytes': 'Size',
  'map.landed.toggleFiles': 'Files',
  'map.landed.barAriaBytes': 'Class composition of the mapped folder, by bytes',
  'map.landed.barAriaFiles': 'Class composition of the mapped folder, by file count',
  'map.landed.axisBytes': '{n} bytes in files',
  'map.landed.axisFiles': '{n} files',
  'map.landed.legendCounts': '{files} files · {bytes}',
  'map.landed.notToScale': 'not to scale',
  'map.landed.notToScaleCaption':
    'Hatched slivers are drawn at a minimum width so they stay visible — their true share is smaller than this chart can honestly draw.',
  'map.landed.class.human_prose': 'Documents & prose',
  'map.landed.class.human_source': 'Code & source',
  'map.landed.class.machine_generated': 'Machine-generated',
  'map.landed.class.media': 'Media',
  'map.landed.class.opaque_container': 'Archives (opaque)',
  'map.landed.class.container': 'Containers',
  'map.landed.class.unclassified': 'Unclassified',
  'map.landed.card.inversionTitle': 'The inversion',
  'map.landed.card.inversionBody':
    'Knowledge is {filesPct}% of your files but {bytesPct}% of your bytes — the two views disagree by {points} points. Neither is wrong; showing only one of them would be.',
  'map.landed.card.emptyTitle': 'Empty folders',
  'map.landed.card.emptyBody':
    '{empty} of {folders} folders — {pct}% — hold nothing at all. Invisible in both bars above, and their names still say something.',
  'map.landed.card.dominantTitle': 'One folder dominates',
  'map.landed.card.dominantBody': '{name} holds {pct}% of every byte the map listed.',
  'map.landed.card.prunedTitle': 'Skipped on purpose',
  'map.landed.card.prunedBody':
    '{bytes} — {pct}% of everything under this root — was pruned by named rules and never walked. The prune report below itemises it.',
  'map.landed.card.opaqueTitle': 'Sealed containers',
  'map.landed.card.opaqueBody':
    '{files} archives hold {pct}% of your bytes, and no name can say what is inside them. Opening them is a different consent.',
  'map.landed.unremarkableTitle': 'An unremarkable drive.',
  'map.landed.unremarkableBody':
    'Files and bytes tell roughly the same story here, and no single number stands out enough to be a finding. That is not a failure — the accounting below still reconciles, which is the part that has to be true.',
  'map.landed.absenceTitle': 'What was measured, and what was not',
  'map.landed.absence.measuredName': 'measured',
  'map.landed.absence.measuredMeaning': 'Enumerated, sized, classified.',
  'map.landed.absence.measuredCount': '{files} files · {bytes}',
  'map.landed.absence.prunedName': 'pruned',
  'map.landed.absence.prunedMeaning': 'Deliberately not walked — each subtree by a named rule, in the report below.',
  'map.landed.absence.prunedCount': '{bytes} across {n} subtrees',
  'map.landed.absence.opaqueName': 'opaque',
  'map.landed.absence.opaqueMeaning':
    'Archives — their contents are unknowable from names alone. Opening them is a different consent.',
  'map.landed.absence.opaqueCount': '{files} files',
  'map.landed.absence.unclassifiedName': 'unclassified',
  'map.landed.absence.unclassifiedMeaning':
    'Walked, but no rule matched. This is the classifier’s own staleness signal, not a property of your files.',
  'map.landed.absence.unclassifiedCount': '{files} files',
  'map.landed.absence.notReachedName': 'not reached',
  'map.landed.absence.notReachedMeaning':
    'The gap between what your drive reports and what the walk accounted for — interrupted, denied or throttled. Distinct from pruned, which was a choice.',
  'map.landed.absence.notReachedCount': '{bytes}',
  'map.landed.absence.emptyName': 'empty',
  'map.landed.absence.emptyMeaning':
    'Zero bytes and zero files — no honest width exists for them in a bar, so this number is the whole picture.',
  'map.landed.absence.emptyCount': '{n} folders',
  'map.landed.reconTitle': 'The accounting',
  'map.landed.reconArithmetic': '{enumerated} in files + {pruned} pruned = {accounted} accounted for.',
  'map.landed.reconDriveGap':
    'Your drive reports {reported}. {accounted} is accounted for above; the remaining {gap} was not reached.',
  'map.landed.reconDriveMatches': 'Your drive reports {reported} — fully accounted for.',
  'map.landed.narrationDroppedRow':
    '{n} narration lines were dropped from the stored record to bound its size. The counts here are unaffected.',
  'map.landed.foldersTitle': 'Top-level folders',
  'map.landed.foldersColFolder': 'Folder',
  'map.landed.foldersColFiles': 'Files',
  'map.landed.foldersColFolders': 'Folders',
  'map.landed.foldersColBytes': 'Bytes',
  'map.landed.rollupTruncatedRow':
    'Only the largest {n} folders are itemised here — {omitted} more are counted in every total above.',
  'map.landed.elidedRow':
    'The live result arrived without this list, and the full record could not be fetched. Every total above is still exact.',
  'map.landed.pruneTitle': 'The prune report',
  'map.landed.pruneCount': '{n} pruned subtrees · {bytes} left unwalked',
  'map.landed.pruneEmpty': 'Nothing was pruned — every folder under the root was walked.',
  'map.landed.pruneTruncatedRow':
    'This list is itself truncated: {omitted} more pruned subtrees are counted in the totals but not itemised here.',
  'map.landed.transcriptTitle': 'The narration, as it ran',
  'map.landed.retry': 'Try the map again',
  'map.landed.remap': 'Map it again',
  'map.landed.failedPartial':
    'Before failing it had listed {items} items across {folders} folders. That partial record remains.',
  'map.landed.reviewCta': 'Review what to ingest',
  'map.landed.reviewCtaSub':
    'Mapping opened nothing. Choosing what to read is the next step — and a separate consent.',
  'map.ledger.title': 'What we suggest reading',
  'map.ledger.subtitle':
    'This is a recommendation with reasons, not a verdict. Every subtraction below is named and counted, so the gap between what the map listed and what we propose is auditable rather than asserted. Nothing has been opened.',
  'map.ledger.loading': 'Loading the suggestion ledger…',
  'map.ledger.loadError':
    'The suggestion ledger could not be loaded right now. Nothing has been decided, and nothing has been read.',
  'map.ledger.loadRetry': 'Try again',
  'map.ledger.noSuggestions':
    'This map produced no suggestion ledger. Runs that finished before this step existed do not have one — re-run the map and the ledger is built with it. Nothing was opened either way.',
  'map.ledger.provenance':
    'Funnel policy {policyVersion} · SHA-256 {policySha} · classifier {classifierVersion} · SHA-256 {classifierSha}',
  'map.ledger.funnelTitle': 'The funnel, every subtraction named',
  'map.ledger.funnelColStage': 'Stage',
  'map.ledger.funnelColFiles': 'Files',
  'map.ledger.funnelColBytes': 'Bytes',
  'map.ledger.funnelColWhy': 'Rule, and why',
  'map.ledger.funnelCandidates': 'Candidates the map listed',
  'map.ledger.funnelDefault': 'Default selection',
  'map.ledger.funnelArithmetic':
    '{candidateFiles} candidates − {subtractedFiles} subtracted = {selectedFiles} selected · {candidateBytes} − {subtractedBytes} = {selectedBytes}.',
  'map.ledger.funnelResidual':
    'These rows do not add up. {candidateFiles} − {subtractedFiles} leaves {expectedFiles}, and the recorded selection is {selectedFiles} — a difference of {residualFiles} files and {residualBytes}. The recorded numbers are shown exactly as they are; the discrepancy is stated rather than hidden, and it is ours to fix.',
  'map.ledger.zerosIncluded':
    'Rules that took nothing are listed with a zero. A rule that only appears when it fires cannot be audited.',
  'map.ledger.rule.archived_dump_copy': 'archived dump copies',
  'map.ledger.rule.stub_under_200b': 'stubs under 200 bytes',
  'map.ledger.rule.receipt_shape': 'receipts',
  'map.ledger.rule.machine_output_in_prose': 'machine output in prose clothing',
  'map.ledger.rule.third_party_publication': 'third-party publications',
  'map.ledger.rule.propagation': 'duplicates of something already removed',
  'map.ledger.rule.duplicate_fingerprint': 'duplicate fingerprints',
  'map.ledger.why.archived_dump_copy':
    'An archived copy of a dump tree holds the same documents already standing somewhere shallower. Where it sits is the evidence, so this rule never travels to other copies.',
  'map.ledger.why.stub_under_200b':
    'A file under 200 bytes has nothing to embed. The floor is a named bound, and how many files it bites is recorded on every run.',
  'map.ledger.why.receipt_shape':
    'Noise, not sensitivity — a delivery receipt teaches the system nothing. Excluded because it carries no knowledge, explicitly not because it is private.',
  'map.ledger.why.machine_output_in_prose':
    'A .txt extension is not authorship. Log dumps and file listings are process output wearing a prose extension.',
  'map.ledger.why.third_party_publication':
    'Ask, don’t assume. Downloaded books, standards and course material are reference somebody else wrote. This is the one rule whose exclusion is a question rather than a verdict — adding these back is exactly what step 12 is for.',
  'map.ledger.why.propagation':
    'A copy of something a document-scoped rule already removed. A receipt is a receipt in every folder it was copied to.',
  'map.ledger.why.duplicate_fingerprint':
    'Collapsed on name and exact size, keeping the shallowest path. Exact size is the honest half of the fingerprint — nothing is collapsed on name alone.',
  'map.ledger.why.unknownRule':
    'This page has no plain-language restatement of that rule yet — the rule id beside it is the record, and it came from the funnel policy named above.',
  'map.ledger.sensitiveTitle': 'Sensitive shapes — reported, not gated',
  'map.ledger.sensitiveBody':
    'Nothing below was removed for being sensitive. Bank statements, tax filings, payroll, identity documents: they are in the selection, because a system you cannot put your own records into is a worse drive search. These are counts of name evidence on your own drive, not a verdict about what is inside the files.',
  'map.ledger.sensitiveColShape': 'Shape',
  'map.ledger.sensitiveColCandidates': 'In candidates',
  'map.ledger.sensitiveColSelected': 'In the default selection',
  'map.ledger.sensitiveNone': 'No named shape matched anything the map listed.',
  'map.ledger.sensitiveCountsOnly':
    'Counts only, deliberately. A ranked table of those paths on one screen is a dossier, and this screen will not build one — the rows below stay in path order and cannot be sorted or filtered by shape.',
  'map.ledger.shape.bank_statement_shape': 'Bank-statement shaped',
  'map.ledger.shape.credential_shape': 'Credential shaped',
  'map.ledger.shape.tax_shape': 'Tax shaped',
  'map.ledger.shape.government_identity_shape': 'Government-identity shaped',
  'map.ledger.shape.legal_shape': 'Legal shaped',
  'map.ledger.shape.insurance_shape': 'Insurance shaped',
  'map.ledger.shape.pastoral_shape': 'Pastoral shaped',
  'map.ledger.shape.payroll_shape': 'Payroll shaped',
  'map.ledger.credentialAdvice':
    '{n} files here look like live secrets — .env files, client secrets, credential notes. Copying one into a search index is a key-hygiene problem, not a privacy one: the secret stays valid and now exists in one more place. Rotate it, don’t exclude it — then read freely. Nothing here is blocked.',
  'map.ledger.sharedTenantNote': '{n} people can sign in to this workspace. Anything read here becomes searchable by all of them. That is not a statement about whether the platform is safe — it is about who is inside the boundary with you.',
  'map.ledger.tenantShapeUnknown':
    'We could not check how many people can sign in to this workspace, so we cannot tell you who else will be able to search what you read. Assume everyone in this workspace can.',
  'map.ledger.rowsTitle': 'Every file, with the reason it is in or out',
  'map.ledger.rowsCount': 'Showing {shown} of {total} rows.',
  'map.ledger.rowsMore': 'Load the next page',
  'map.ledger.rowsLoadingMore': 'Loading more rows…',
  'map.ledger.rowsComplete': 'That is every row in the ledger.',
  'map.ledger.rowsPageCapNote': 'One page carries at most {cap} rows.',
  'map.ledger.rowsCursorInvalid':
    'The server did not recognise the position we asked to continue from, so no further rows were loaded. What is above is still exact; reload the page to start the listing again.',
  'map.ledger.rowsPageFailed': 'The next page of rows could not be loaded. What is above is still exact.',
  'map.ledger.rowsTruncated':
    'The ledger itself stops at {cap} rows — {omitted} more files are counted in every total above but are not itemised here. A decision cannot be recorded against a partial ledger, so this drive cannot be decided yet, and nothing will be read.',
  'map.ledger.verdictSelected': 'selected',
  'map.ledger.verdictSubtracted': 'removed by {rule}',
  'map.ledger.verdictPropagated': 'removed with its duplicate, by {rule}',
  'map.ledger.verdictNotCandidate': 'not a candidate — classified {class}',
  'map.ledger.rankUnranked': 'unranked',
  'map.ledger.rankUnrankedCaption':
    'These rows carry no rank, and this list is in path order — which is not a quality ranking and is not presented as one. The reason on record: {reason}',
  'map.ledger.rankValue': 'rank {rank}',
  'map.ledger.rankTie': 'tied at rank {rank} with {others} others',
  'map.ledger.rankArbitrary': 'order inside this tie is arbitrary',
  'map.ledger.rowShapesLabel': 'shapes:',
  'map.ledger.colFile': 'File',
  'map.ledger.colSize': 'Size',
  'map.ledger.colReason': 'Reason',
  'map.ledger.colAction': 'Change it',
  'map.decide.title': 'Remove what you disagree with',
  'map.decide.body':
    'Removing something is one click. Adding back something a rule took out asks you to read the rule first — the friction is deliberately asymmetric, because a wrong removal costs you one document you can put back, and a wrong addition is a decision you never actually made.',
  'map.decide.remove': 'Remove',
  'map.decide.removedMark': 'Removed',
  'map.decide.undo': 'Undo',
  'map.decide.readdOpen': 'Add back…',
  'map.decide.readdCancel': 'Leave it out',
  'map.decide.readdConfirm': 'Add it back anyway',
  'map.decide.readdTitle': 'Adding back {name}',
  'map.decide.readdRestated':
    'This file was taken out by “{rule}”. {why} Adding it back overrides that rule for this one file.',
  'map.decide.readdRestatedPropagated':
    'This file was taken out because a fingerprint-identical copy of it was taken out by “{rule}”. {why} Adding it back overrides that for this one file; the other copies are unaffected.',
  'map.decide.readdRestatedNotCandidate':
    'This file was never a candidate: the classifier filed it as {class}, and only some classes are proposed for reading. Adding it back overrides that for this one file.',
  'map.decide.readdedMark': 'Added back',
  'map.decide.totalsTitle': 'Your selection right now',
  'map.decide.totalsCounts': '{files} files · {bytes}',
  'map.decide.totalsDelta': '{removed} removed and {readded} added back, from a default of {defaultFiles} files.',
  'map.decide.totalsUnchanged': 'Unchanged from the default selection.',
  'map.decide.costRange': 'Estimated {low}–{high} tokens.',
  'map.decide.costBinaryShare':
    '{pct}% of this selection is PDF and Word, where size predicts text poorly — so this is a range, and we reconcile after parsing.',
  'map.decide.costAllText':
    'This selection is entirely plain-text formats, where bytes predict text well — but it is still a range, and we reconcile after parsing.',
  'map.decide.costMethod': 'How this is worked out: {method}',
  'map.decide.costDisagreement':
    'This page and the server do not agree on the token range for the unchanged selection, so the server’s numbers are the ones shown and this page’s arithmetic is not used for your edits. That disagreement is a bug on our side, not a fact about your drive.',
  'map.decide.costEditedUnavailable':
    'A token range for the edited selection cannot be worked out on this page while that disagreement stands. The file and byte totals above are exact.',
  'map.decide.save': 'Save this decision',
  'map.decide.saving': 'Saving…',
  'map.decide.saved': 'Decision saved {date}.',
  'map.decide.unsaved': 'You have changes that are not saved. Nothing is read until you save and then approve.',
  'map.decide.continue': 'Continue — approve the reading',
  'map.decide.saveErrorPathUnknown':
    'The server does not recognise {path} in this ledger ({field}), so nothing was saved. The ledger may have been rebuilt by a newer map — reload this page.',
  'map.decide.saveErrorInvalid': 'The {field} we sent was not a valid list of paths, so nothing was saved.',
  'map.decide.saveErrorNoLedger': 'There is no suggestion ledger to decide against any more, so nothing was saved.',
  'map.decide.saveErrorTruncated':
    'This drive’s ledger is larger than one record can hold, so a decision cannot be recorded against it. Nothing was saved, and nothing will be read.',
  'map.decide.saveErrorConnection': 'This connection no longer exists, so nothing was saved.',
  'map.decide.saveFailed': 'The decision was not saved. Your changes are still here — try again.',
  'ingestConsent.title': 'Open and read the files you chose.',
  'ingestConsent.honesty':
    'This is the second consent, and it is the one that opens documents. Reading names was never permission to read words.',
  'ingestConsent.selectionLine': '{files} files · {bytes}, decided {date}.',
  'ingestConsent.selectionLineUndated': '{files} files · {bytes}.',
  'ingestConsent.costTitle': 'What this will cost',
  'ingestConsent.clearanceLabel': 'Data classification for these files',
  'ingestConsent.clearanceHelp':
    'Classification is a decision about what is inside these files. The folder picker deliberately stopped asking, because nothing had been read yet — now the map has shown you what is here, so this is the moment the question can honestly be answered. It is capped at your own clearance, and you can change it later.',
  'ingestConsent.labelCap': 'The operator’s policy may record these files at a lower label than the one you choose — it lowers, never raises. If that happens, the recorded label is the capped one; this is that bound named before it bites rather than after.',
  'ingestConsent.clearanceEvidence': 'What the map found in this selection, as evidence for that choice:',
  'ingestConsent.cta': 'Open and read {n} files',
  'ingestConsent.ctaOne': 'Open and read 1 file',
  'ingestConsent.granting': 'Recording your consent…',
  'ingestConsent.starting': 'Starting the read…',
  'ingestConsent.retryStart': 'Start the read again',
  'ingestConsent.alreadyConsented':
    'Reading consent is already on record for this connection — granted {date}. Starting a read will not ask again; revoking the consent is what withdraws it.',
  'ingestConsent.staleDisclosure':
    'The consent text changed while this page was open. Nothing was recorded and nothing was read. The current version is below — read it before continuing.',
  'ingestConsent.connectorsDisabled':
    'An administrator has connectors switched off for this workspace. No file can be read until they are switched back on.',
  'ingestConsent.consentNotActive':
    'The server has no active reading consent for this connection — it may have just been revoked. Read the text below and consent again if you still want the files read.',
  'ingestConsent.grantFailed': 'Your consent was not recorded, so nothing was started and nothing was read. Try again.',
  'ingestConsent.startFailed':
    'Your consent is on record. Starting the read itself failed — try again below; you will not be asked to consent twice.',
  'ingestConsent.connectionGone': 'This connection no longer exists. Go back to connectors and reconnect a drive.',
  'ingestConsent.noSelection':
    'The server has no decision on record for this connection, so there is nothing to read. Go back to the ledger and save your decision — nothing was read.',
  'ingestConsent.backToLedger': 'Back to the ledger',
  'map.ingestStarted.title': 'Reading has started.',
  'map.ingestStarted.body':
    '{files} files are being opened and read now. It runs in the background — you can leave this page.',
  'map.ingestStarted.workflow': 'Run {workflowId}',
  'map.ingestStarted.watch':
    'Live progress is on the connectors screen: files read against the {files} you approved, folder by folder, updating while it runs.',
  'map.ingestStarted.cta': 'Watch it read your files',
  'connectors.oauthError': 'Connection failed: {error}',
  'connectors.provider.onedrive': 'OneDrive',
  'connectors.provider.sharepoint': 'SharePoint',
  'connectors.reading.title': 'Reading your {provider} files…',
  'connectors.syncing.currentFolder': 'Currently in {folder}',
  'connectors.syncing.counts': '{folders} folders scanned · {discovered} found · {ingested} read · {skipped} skipped · {deferred} deferred · {failed} failed',
  'connectors.syncing.recentTitle': 'Files just read',
  'connectors.syncing.filesIngestedLabel': 'files read',
  'connectors.syncing.foldersScannedLabel': 'folders scanned',
  'connectors.fileStatus.ingested': 'Ingested',
  'connectors.fileStatus.skipped': 'Skipped',
  'connectors.fileStatus.failed': 'Failed',
  'connectors.complete.title': 'Sync complete',
  'connectors.complete.summary': '{ingested} of {discovered} files ingested',
  'connectors.complete.withFailures': ', {failed} failed',
  'connectors.complete.titlePartial': 'Sync finished with failures',
  'connectors.complete.ctaSubtitlePartial': 'Chat and search across the {ingested} files that were ingested. {failed} could not be read and are NOT searchable.',
  'connectors.complete.partialHint': 'This folder is only partly searchable. "Retry failed files" re-attempts just the failures.',
  'connectors.complete.duration': 'in {duration}',
  'connectors.complete.ctaSubtitle': 'Chat and search across everything ingested from {folder}',
  'connectors.complete.cta': 'Start working with these files',
  'connectors.complete.emptySummary': 'No files found after scanning {folders} folders',
  'connectors.complete.emptySummaryNoFolders': 'This folder is empty',
  'connectors.complete.emptyHint': 'Try a different root folder with "Change folder" below.',
  'connectors.failed.title': 'Sync failed',
  'connectors.failed.hint': 'Retrying re-attempts just the failed files, not the whole sync.',
  'connectors.retryFailed': 'Retry failed files',
  'connectors.fileStatus.deferred': 'Deferred',
  'connectors.fileStatus.unknown': 'Unknown state',
  'connectors.ingest.title': 'Reading the files you approved',
  'connectors.ingest.readLabel': 'files read',
  'connectors.ingest.selectedLabel': 'you approved',
  'connectors.ingest.currentFile': 'Reading {path}',
  'connectors.ingest.currentFileNone': 'Opening the first file\u2026',
  'connectors.ingest.progress': '{done} of {selected} files \u00b7 {pct}%',
  'connectors.ingest.progressStale':
    '{done} files handled, more than the {selected} you approved \u2014 the approved total is out of date for this run, so no percentage is shown. The counts are still exact.',
  'connectors.ingest.progressNoDenominator':
    '{done} files handled. This run did not record how many you approved, so there is no percentage to show \u2014 only a bar drawn to a real total would mean anything.',
  'connectors.ingest.nRead': '{n} read',
  'connectors.ingest.nFailed': '{n} failed',
  'connectors.ingest.nDeferred': '{n} deferred',
  'connectors.ingest.nSkipped': '{n} skipped',
  'connectors.ingest.foldersTitle': 'By folder',
  'connectors.ingest.folderRow': '{ingested} of {selected} read',
  'connectors.ingest.foldersShown': 'Showing {shown} of {total} folders, the ones needing attention first.',
  'connectors.ingest.foldersOmitted':
    '{omitted} more folders were not itemised by this run. Their files are still counted in the totals above.',
  'connectors.ingest.failuresNotItemized':
    'Which files failed is recorded on the run itself; this screen can show the causes but not yet the file list.',
  'connectors.ingest.failuresOmitted': '{omitted} of the failures were not itemised even there.',
  'connectors.ingest.runLabel': 'Run {runId}',
  'connectors.ingest.completeTitle': 'Every approved file was read',
  'connectors.ingest.completeTitleWithSkips': 'Read \u2014 with some files skipped',
  'connectors.ingest.completeSummary': '{ingested} of the {selected} files you approved are searchable now.',
  'connectors.ingest.completeSummaryNoDenominator': '{ingested} files are searchable now.',
  'connectors.ingest.partialTitle': 'Finished with failures',
  'connectors.ingest.partialSummary':
    '{ingested} files are searchable. {failed} could not be read and are NOT searchable.',
  'connectors.ingest.deferredTitle': 'Deferred — the destination declined the rest for now',
  'connectors.ingest.deferredSummary': '{ingested} files are searchable. {deferred} are parked — nothing is lost and nothing failed.',
  'connectors.ingest.nothingReadTitle': 'Nothing became searchable',
  'connectors.ingest.nothingReadSummary':
    'All {done} files were skipped without being opened. Nothing from this run is searchable.',
  'connectors.ingest.nothingDoneTitle': 'Nothing was read',
  'connectors.ingest.nothingDoneSelected':
    'You approved {selected} files and this run handled none of them. Nothing was opened and nothing was changed.',
  'connectors.ingest.nothingDoneEmptySelection':
    'This run finished with an empty selection \u2014 no files were approved, so none were opened.',
  'connectors.ingest.failedTitle': 'The read stopped early',
  'connectors.ingest.failedSummary':
    'This run stopped before it finished. {ingested} files were read before it stopped and are searchable; the rest were not.',
  'connectors.ingest.refusedNoConsentTitle': 'The read was refused',
  'connectors.ingest.refusedNoConsent':
    'No active consent to read file contents was on record when this run started, so nothing was opened. Review the selection to grant it again.',
  'connectors.ingest.refusedUnsupportedTitle': 'This drive cannot be read',
  'connectors.ingest.refusedUnsupported':
    'This connection\u2019s provider has no reader on this platform, so nothing was opened. No consent was used.',
  'connectors.ingest.unrecognizedTitle': 'This run reported a state this screen does not know',
  'connectors.ingest.unrecognizedBody':
    'The run reported \u201c{status}\u201d. This page is older than the service that wrote it, so it will not guess what that means. The counts below are exactly what the run recorded.',
  'connectors.ingest.cta': 'Start working with these files',
  'connectors.ingest.reviewCta': 'Review the selection and read again',
  'connectors.cause.title': 'Why files were not read',
  'connectors.cause.failed': 'Opened, but could not be read',
  'connectors.cause.failedAdvice':
    'These files were downloaded and the reader could not get text out of them. Reading them again can work if the cause was temporary; each document carries its own recorded reason.',
  'connectors.cause.deferred': 'Deferred — the ingest destination declined it for now',
  'connectors.cause.deferredAdvice': 'Not failures, and nothing is lost. The ingest destination declined these for now — quota, budget or backpressure on its side — and the retry pass re-submits them automatically once it accepts again. Reading again by hand does not speed that up.',
  'connectors.cause.alreadyIngested': 'Already read by an earlier run',
  'connectors.cause.alreadyIngestedAdvice':
    'These were already in your corpus, so they were not read or charged for twice. They are searchable now. Nothing to do.',
  'connectors.cause.tooLarge': 'Larger than the size ceiling',
  'connectors.cause.tooLargeAdvice':
    'Never downloaded and never opened, so nothing was spent on them. Split the file, or upload the part you need directly, and it will be read.',
  'connectors.cause.unsupportedType': 'Not a file type the reader opens',
  'connectors.cause.unsupportedTypeAdvice':
    'Never downloaded. Save it as PDF, DOCX or plain text and it will be read. Reading again as-is will skip it again.',
  'connectors.cause.unnamed': 'Skipped without a recorded reason',
  'connectors.cause.unnamedAdvice':
    'The run skipped these without naming why. That is a gap in our record rather than something you can fix \u2014 tell us and we will chase it.',
  'connectors.cause.recoveryNone': 'Nothing to do',
  'connectors.cause.recoveryAutomatic': 'Recovers on its own',
  'connectors.cause.recoveryCustomer': 'You can fix this',
  'connectors.cause.recoveryRetry': 'Reading again may help',
  'connectors.cause.recoveryUnknown': 'Cause not recorded',
  'connectors.complete.titleDeferred': 'Deferred — the rest is parked, not failed',
  'connectors.complete.deferredHint': '{deferred} files are parked, not failed. The ingest destination declined them for now; they finish on their own once it accepts them.',
  'connectors.complete.emptyWithFailures':
    'No files were found in this folder, and {failed} files carried over from the last run failed again. They are still not searchable.',
  'connectors.sync.deltaReenumerated':
    'The saved change-marker for this drive had expired, so this run walked the whole folder again ({n}\u00d7). Nothing was read twice.',
  'connectors.browse.serverTruncated': 'The server stopped listing at its own ceiling — this list is NOT complete. Load the rest to continue from where it stopped.',
};
