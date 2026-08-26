// SPDX-License-Identifier: Apache-2.0
import type { MessageDict } from './types.js';

export const esMX: MessageDict = {
  'labels.commercial': 'comercial',
  'labels.unclassified': 'no clasificado',
  'labels.ear_restricted': 'restringido EAR',
  'labels.itar_restricted': 'restringido ITAR',
  'labels.sovereign': 'soberano',
  'labels.government': 'gubernamental',
  'connectors.navLink': 'Conectores',
  'connectors.title': 'Conectores de documentos',
  'connectors.listError': 'No se pudieron cargar los conectores',
  'connectors.rootLabel': 'Raíz',
  'connectors.connectError': 'No se pudo iniciar la conexión',
  'connectors.browseError': 'No se pudieron explorar las carpetas',
  'connectors.syncError': 'No se pudo iniciar la sincronización',
  'connectors.disconnectError': 'No se pudo desconectar',
  'connectors.connectTitle': 'Conectar una fuente',
  'connectors.connectSubtitle': 'Ingiere documentos desde OneDrive o SharePoint, incluidas las carpetas anidadas.',
  'connectors.connecting': 'Conectando…',
  'connectors.connectOneDrive': 'Conectar OneDrive',
  'connectors.connectSharePoint': 'Conectar SharePoint',
  'connectors.loading': 'Cargando conectores…',
  'connectors.empty': 'Aún no hay conectores — conecta una fuente arriba para comenzar.',
  'connectors.noRootYet': 'Aún no se ha seleccionado ninguna carpeta',
  'connectors.status.connected': 'Conectado',
  'connectors.status.syncing': 'Sincronizando',
  'connectors.status.error': 'Error',
  'connectors.status.disconnected': 'Desconectado',
  'connectors.changeRoot': 'Cambiar carpeta',
  'connectors.pickRoot': 'Elegir una carpeta',
  'connectors.disconnect': 'Desconectar',
  'connectors.browsing': 'Cargando carpetas…',
  'connectors.startingSync': 'Iniciando…',
  'connectors.cancel': 'Cancelar',
  'connectors.oauthHandoff.title': '{grantor} te pedirá permiso a continuación',
  'connectors.oauthHandoff.body':
    'Esa pantalla es de ellos, no nuestra. Concede acceso de lectura a tu unidad — aun así no abriremos ninguno de tus archivos hasta que tú lo autorices.',
  'connectors.oauthHandoff.continue': 'Continuar a {grantor}',
  'connectors.oauthHandoff.cancel': 'Ahora no',
  'connectors.grantor.microsoft': 'Microsoft',
  'connectors.browseScopeHint':
    'No pudimos abrir esa carpeta. Microsoft responde "no encontrada" tanto para una carpeta que ya no existe como para una que esta conexión nunca tuvo permiso de ver, así que desde aquí se ven idénticas. Desconecta esta unidad, vuelve a conectarla y acepta todos los permisos en su pantalla. Si aun así falla, la carpeta se movió o se eliminó.',
  'connectors.browseScopeMissingHint':
    'A esta conexión nunca se le concedió permiso para leer esa carpeta. Desconecta esta unidad, vuelve a conectarla y acepta todos los permisos en la pantalla del proveedor.',
  'connectors.browseFolderNotFoundHint':
    'Esa carpeta ya no está — la movieron, la renombraron o la eliminaron en tu unidad. Tu conexión está bien; regresa y elige una carpeta que sí exista.',
  'connectors.browseDisconnectedHint':
    'Esta unidad está desconectada, así que no hay nada que listar. Vuelve a conectarla para explorarla.',
  'connectors.browseDisabledHint':
    'Los conectores de unidades están desactivados para este espacio de trabajo. Un administrador puede volver a activarlos.',
  'connectors.browseThrottledHint':
    'Tu proveedor nos pidió ir más despacio. Espera unos {seconds} segundos y luego carga el resto — no se perdió nada de lo ya listado.',
  'connectors.browseThrottledHintNoDelay':
    'Tu proveedor nos pidió ir más despacio. Espera un momento y luego carga el resto — no se perdió nada de lo ya listado.',
  'connectors.browseThrottledRetryHint':
    'Tu proveedor nos pidió ir más despacio. Espera unos {seconds} segundos e inténtalo de nuevo.',
  'connectors.browseThrottledRetryHintNoDelay':
    'Tu proveedor nos pidió ir más despacio. Espera un momento e inténtalo de nuevo.',
  'connectors.browseFailedHint':
    'No pudimos listar esa carpeta. Inténtalo de nuevo — y si sigue fallando, desconecta esta unidad y vuelve a conectarla.',
  'connectors.browseUnreadableHint':
    'Tu unidad respondió, pero la respuesta no fue algo que pudiéramos leer — así que no sabemos qué hay en esta carpeta. Eso es una falla nuestra, no una carpeta vacía. Inténtalo de nuevo.',
  'connectors.browseSignedOutHint':
    'Tu sesión expiró, así que no pudimos verificar esta solicitud. Vuelve a iniciar sesión y regresa a esta carpeta. Tu conexión de unidad está intacta — y volver a conectarla no ayudaría, porque eso necesita una sesión válida para completarse.',
  'connectors.browsePolicyDeniedHint':
    'La política de seguridad de tu espacio de trabajo bloqueó esta solicitud. La conexión de la unidad no es el problema, así que volver a conectarla no cambiaría nada — pide a un administrador que revise la política de este espacio de trabajo.',
  'connectors.browseConnectionGoneHint':
    'Esta conexión de unidad ya no está disponible para tu espacio de trabajo — se eliminó, o nunca fue tuya para explorarla. Aquí no hay nada que desconectar: recarga esta página y la lista mostrará las conexiones que sí existen.',
  'connectors.browseServerErrorHint':
    'Algo falló de nuestro lado al listar esta carpeta. Tu unidad y tu conexión están bien — inténtalo de nuevo en un momento, y si sigue fallando nos toca a nosotros arreglarlo, no es algo que una reconexión cure.',
  'connectors.browseUnexpectedHint':
    'No pudimos listar esa carpeta y el motivo que recibimos no es uno que reconozcamos. Inténtalo de nuevo — y no desconectes la unidad por esto; si sigue ocurriendo, dinos cuándo pasó.',
  'connectors.browseRetry': 'Reintentar',
  'connectors.sharepointSite.prompt':
    'SharePoint aloja muchos sitios y tu inicio de sesión no indica cuál quieres. Pégalo desde la barra de direcciones del sitio de SharePoint que buscas.',
  'connectors.sharepointSite.hostnameLabel': 'Dirección de SharePoint',
  'connectors.sharepointSite.hostnamePlaceholder': 'contoso.sharepoint.com',
  'connectors.sharepointSite.pathLabel': 'Ruta del sitio',
  'connectors.sharepointSite.pathPlaceholder': '/sites/Finanzas',
  'connectors.sharepointSite.submit': 'Abrir este sitio',
  'connectors.browse.folderEmpty': 'Esta carpeta está vacía.',
  'connectors.browse.complete': 'Los {n} elementos de esta carpeta.',
  'connectors.browse.partial': '{n} elementos hasta ahora. Esta carpeta tiene más — esta lista NO está completa.',
  'connectors.browse.partialNone':
    'Todavía no se ha listado nada y falta leer más de esta carpeta — esta lista NO está completa.',
  'connectors.browse.incompleteUnknown':
    'El listado de esta carpeta se detuvo antes de tiempo, así que lo que ves aquí puede no ser todo.',
  'connectors.browse.loadMore': 'Cargar el resto',
  'connectors.browse.loadingMore': 'Cargando más…',
  'connectors.browse.sizeUnknown': 'tamaño no informado',
  'connectors.browse.modifiedUnknown': 'fecha no informada',
  'connectors.browse.emptyMarker': 'vacía',
  'connectors.browse.childCount': '{n} elementos',
  'connectors.browse.childCountUnknown': 'número de elementos no informado',
  'connectors.browse.folderRowLabel': 'Carpeta',
  'connectors.browse.fileRowLabel': 'Archivo',
  'connectors.clearanceCarriedNote':
    'Por ahora esta carpeta queda clasificada como {clearance}. La clasificación es una decisión sobre lo que hay dentro de estos archivos, y todavía no se ha leído nada — la defines cuando el mapa te lo muestre.',
  'map.pickRoot.cta': 'Mapear esta carpeta',
  'map.pickRoot.ctaSubtitle': 'Vamos a listar lo que hay aquí. No lo vamos a abrir.',
  'map.title': 'Mapa del drive',
  'map.back': 'Volver a conectores',
  'map.resolving': 'Revisando esta conexión…',
  'map.resolveError': 'No pudimos revisar el estado de este mapa en este momento.',
  'map.resolveRetry': 'Intentar de nuevo',
  'mapConsent.title': 'Leer los nombres, no los archivos.',
  'mapConsent.honesty':
    'Una carpeta llamada “Divorcio 2019” nos dice algo aunque esté vacía. Leer nombres es menos que leer archivos — pero no es nada.',
  'mapConsent.scopeLine': 'Cubre {folder} y todo lo que contiene.',
  'mapConsent.scopeLineUnknown':
    'No pudimos confirmar qué carpeta tiene configurada esta conexión. El mapa cubrirá la carpeta configurada para esta conexión — recarga para verla nombrada antes de decidir.',
  'mapConsent.cta': 'Mapear esta carpeta — leer solo nombres',
  'mapConsent.granting': 'Registrando tu consentimiento…',
  'mapConsent.starting': 'Iniciando el mapa…',
  'mapConsent.retryStart': 'Iniciar el mapa de nuevo',
  'mapConsent.alreadyConsented':
    'El consentimiento de mapeo ya está registrado para esta conexión — otorgado el {date}. Iniciar otro mapa no lo vuelve a pedir; revocarlo es lo que lo retira.',
  'mapConsent.disclosureTitle': 'Las palabras exactas que quedan registradas',
  'mapConsent.disclosureSha': 'SHA-256 {sha}',
  'mapConsent.disclosureLoading': 'Obteniendo el texto de consentimiento…',
  'mapConsent.disclosureError': 'No se pudo obtener el texto de consentimiento, así que todavía no hay nada que consentir.',
  'mapConsent.disclosureRetry': 'Obtenerlo de nuevo',
  'mapConsent.staleDisclosure':
    'El texto de consentimiento cambió mientras esta página estaba abierta. No se registró nada. La versión vigente está abajo — léela antes de continuar.',
  'mapConsent.mappingDisabled':
    'Un administrador tiene el mapeo desactivado para este espacio de trabajo. Ningún mapa puede iniciar hasta que se reactive.',
  'mapConsent.connectorsDisabled':
    'Un administrador tiene los conectores desactivados para este espacio de trabajo. Ningún mapa puede iniciar hasta que se reactiven.',
  'mapConsent.consentNotActive':
    'El servidor no tiene un consentimiento de mapeo activo para esta conexión — puede que se acabe de revocar. Lee el texto de abajo y consiente de nuevo si aún quieres el mapa.',
  'mapConsent.grantFailed': 'Tu consentimiento no quedó registrado, así que no se inició nada. Intenta de nuevo.',
  'mapConsent.startFailed':
    'Tu consentimiento está registrado. Lo que falló fue iniciar el mapa — intenta de nuevo abajo; no se te pedirá consentir dos veces.',
  'mapConsent.connectionGone': 'Esta conexión ya no existe. Vuelve a conectores y conecta un drive de nuevo.',
  'mapConsent.vs.caption': 'Los dos verbos, lado a lado',
  'mapConsent.vs.mapCol': 'Mapear — este consentimiento',
  'mapConsent.vs.ingestCol': 'Ingerir — un consentimiento posterior y separado',
  'mapConsent.vs.rowOpened': 'Archivos abiertos',
  'mapConsent.vs.ingestOpenedUnknown': 'cada archivo que apruebes entonces — contado en ese paso',
  'mapConsent.vs.rowRead': 'Qué leemos',
  'mapConsent.vs.readMap': 'nombres, tamaños, fechas, permisos',
  'mapConsent.vs.readIngest': 'el texto que contienen',
  'mapConsent.vs.rowLeaves': 'Qué sale de tu espacio de trabajo',
  'mapConsent.vs.leavesMap': 'nombres y conteos, al servicio de inferencia',
  'mapConsent.vs.leavesIngest': 'texto de los documentos, al servicio de inferencia',
  'mapConsent.vs.rowReversible': 'Reversible',
  'mapConsent.vs.reversibleMap': 'sí — borra el mapa',
  'mapConsent.vs.reversibleIngest': 'sí — pero los embeddings se reconstruyen; lo leído no se des-lee',
  'map.stage.mappingTitle': 'El mapa está corriendo.',
  'map.stage.mappingBody': 'Leyendo nombres, tamaños, fechas y estructura de carpetas — sin abrir nada.',
  'map.stage.completeTitle': 'El mapa está completo.',
  'map.stage.completeSummary': '{items} elementos listados en {folders} carpetas. No se abrió ningún archivo.',
  'map.stage.completeNoCounts': 'La corrida terminó. No se abrió ningún archivo.',
  'map.stage.failedTitle': 'El mapa falló.',
  'map.stage.failedBody':
    'El mapa se detuvo antes de terminar. Lo que alcanzó a listar queda registrado; no se abrió ningún archivo.',
  'map.stream.header': 'narración en vivo',
  'map.stream.replay': 'Repetir',
  'map.stream.tierNone': 'sin modelo',
  'map.stream.waitingFirstLine': 'Esperando la primera línea…',
  'map.stream.capNotice':
    'Mostrando las últimas {shown} de {total} líneas — las anteriores salieron de esta vista. La narración completa queda en el registro.',
  'map.stream.fallbackNotice':
    'La transmisión en vivo no pudo mantenerse abierta, así que esta página revisa el progreso cada pocos segundos. No se pierde nada — la narración se pone al día en cada revisión.',
  'map.stream.progressCounts': '{items} elementos listados · {folders} carpetas recorridas',
  'map.stream.progressPath': 'leyendo nombres en {path}',
  'map.stream.kindSum': 'aritmética',
  'map.stream.kindChk': 'verificación',
  'map.stream.kindAsk': 'consulta al modelo',
  'map.stream.kindFix': 'corrección',
  'map.stream.failedTranscript': 'La narración de arriba es el registro de hasta dónde llegó. Permanece.',
  'map.refused.noConsentTitle': 'El mapa se detuvo: el consentimiento fue revocado.',
  'map.refused.noConsentBody':
    'El consentimiento de mapeo fue revocado mientras la corrida estaba en curso, así que se detuvo donde estaba. No se leyó nada más.',
  'map.refused.partialProgress':
    'Antes de detenerse, había listado {items} elementos en {folders} carpetas. Ese registro parcial permanece.',
  'map.refused.unsupportedTitle': 'Este drive todavía no se puede mapear.',
  'map.refused.unsupportedBody': 'El mapeo aún no está disponible para este proveedor. No se leyó nada.',
  'map.landed.noFiles':
    'El mapa no listó ningún archivo bajo esta carpeta. La estructura de carpetas de abajo sigue siendo el registro.',
  'map.landed.headline':
    'El conocimiento — tus documentos y tu código — es el {filesPct}% de tus archivos y el {bytesPct}% de tus bytes.',
  'map.landed.byBytes': 'Por bytes — lo que el almacenamiento te cobra',
  'map.landed.byFiles': 'Por número de archivos — lo que una persona llama “mis archivos”',
  'map.landed.encodingGroup': 'Codificación',
  'map.landed.toggleBytes': 'Tamaño',
  'map.landed.toggleFiles': 'Archivos',
  'map.landed.barAriaBytes': 'Composición por clase de la carpeta mapeada, por bytes',
  'map.landed.barAriaFiles': 'Composición por clase de la carpeta mapeada, por número de archivos',
  'map.landed.axisBytes': '{n} bytes en archivos',
  'map.landed.axisFiles': '{n} archivos',
  'map.landed.legendCounts': '{files} archivos · {bytes}',
  'map.landed.notToScale': 'fuera de escala',
  'map.landed.notToScaleCaption':
    'Las franjas con trama se dibujan a un ancho mínimo para que sigan visibles — su proporción real es menor de lo que esta gráfica puede dibujar con honestidad.',
  'map.landed.class.human_prose': 'Documentos y prosa',
  'map.landed.class.human_source': 'Código y fuentes',
  'map.landed.class.machine_generated': 'Generado por máquina',
  'map.landed.class.media': 'Multimedia',
  'map.landed.class.opaque_container': 'Archivos comprimidos (opacos)',
  'map.landed.class.container': 'Contenedores',
  'map.landed.class.unclassified': 'Sin clasificar',
  'map.landed.card.inversionTitle': 'La inversión',
  'map.landed.card.inversionBody':
    'El conocimiento es el {filesPct}% de tus archivos pero el {bytesPct}% de tus bytes — las dos vistas difieren por {points} puntos. Ninguna está mal; mostrar solo una sí lo estaría.',
  'map.landed.card.emptyTitle': 'Carpetas vacías',
  'map.landed.card.emptyBody':
    '{empty} de {folders} carpetas — el {pct}% — no contienen nada. Invisibles en ambas barras de arriba, y sus nombres aún dicen algo.',
  'map.landed.card.dominantTitle': 'Una carpeta domina',
  'map.landed.card.dominantBody': '{name} contiene el {pct}% de cada byte que el mapa listó.',
  'map.landed.card.prunedTitle': 'Omitido a propósito',
  'map.landed.card.prunedBody':
    '{bytes} — el {pct}% de todo lo que hay bajo esta raíz — fue podado por reglas con nombre y nunca se recorrió. El reporte de poda de abajo lo detalla.',
  'map.landed.card.opaqueTitle': 'Contenedores sellados',
  'map.landed.card.opaqueBody':
    '{files} archivos comprimidos contienen el {pct}% de tus bytes, y ningún nombre puede decir qué hay dentro. Abrirlos es un consentimiento distinto.',
  'map.landed.unremarkableTitle': 'Un drive sin nada notable.',
  'map.landed.unremarkableBody':
    'Aquí los archivos y los bytes cuentan más o menos la misma historia, y ningún número destaca lo suficiente para ser un hallazgo. Eso no es un fallo — la contabilidad de abajo sigue cuadrando, que es la parte que tiene que ser cierta.',
  'map.landed.absenceTitle': 'Qué se midió, y qué no',
  'map.landed.absence.measuredName': 'medido',
  'map.landed.absence.measuredMeaning': 'Enumerado, dimensionado, clasificado.',
  'map.landed.absence.measuredCount': '{files} archivos · {bytes}',
  'map.landed.absence.prunedName': 'podado',
  'map.landed.absence.prunedMeaning':
    'Deliberadamente no recorrido — cada subárbol por una regla con nombre, en el reporte de abajo.',
  'map.landed.absence.prunedCount': '{bytes} en {n} subárboles',
  'map.landed.absence.opaqueName': 'opaco',
  'map.landed.absence.opaqueMeaning':
    'Archivos comprimidos — su contenido no se puede conocer solo por los nombres. Abrirlos es un consentimiento distinto.',
  'map.landed.absence.opaqueCount': '{files} archivos',
  'map.landed.absence.unclassifiedName': 'sin clasificar',
  'map.landed.absence.unclassifiedMeaning':
    'Recorrido, pero ninguna regla coincidió. Es la señal de desactualización del propio clasificador, no una propiedad de tus archivos.',
  'map.landed.absence.unclassifiedCount': '{files} archivos',
  'map.landed.absence.notReachedName': 'no alcanzado',
  'map.landed.absence.notReachedMeaning':
    'La brecha entre lo que tu drive reporta y lo que el recorrido contabilizó — interrumpido, denegado o limitado. Distinto de podado, que fue una decisión.',
  'map.landed.absence.notReachedCount': '{bytes}',
  'map.landed.absence.emptyName': 'vacío',
  'map.landed.absence.emptyMeaning':
    'Cero bytes y cero archivos — no existe un ancho honesto para ellos en una barra, así que este número es el cuadro completo.',
  'map.landed.absence.emptyCount': '{n} carpetas',
  'map.landed.reconTitle': 'La contabilidad',
  'map.landed.reconArithmetic': '{enumerated} en archivos + {pruned} podados = {accounted} contabilizados.',
  'map.landed.reconDriveGap':
    'Tu drive reporta {reported}. {accounted} está contabilizado arriba; los {gap} restantes no fueron alcanzados.',
  'map.landed.reconDriveMatches': 'Tu drive reporta {reported} — contabilizado por completo.',
  'map.landed.narrationDroppedRow':
    '{n} líneas de narración se descartaron del registro almacenado para acotar su tamaño. Los conteos de aquí no se ven afectados.',
  'map.landed.foldersTitle': 'Carpetas de primer nivel',
  'map.landed.foldersColFolder': 'Carpeta',
  'map.landed.foldersColFiles': 'Archivos',
  'map.landed.foldersColFolders': 'Carpetas',
  'map.landed.foldersColBytes': 'Bytes',
  'map.landed.rollupTruncatedRow':
    'Solo las {n} carpetas más grandes se detallan aquí — {omitted} más están contadas en cada total de arriba.',
  'map.landed.elidedRow':
    'El resultado en vivo llegó sin esta lista, y el registro completo no se pudo obtener. Cada total de arriba sigue siendo exacto.',
  'map.landed.pruneTitle': 'El reporte de poda',
  'map.landed.pruneCount': '{n} subárboles podados · {bytes} sin recorrer',
  'map.landed.pruneEmpty': 'No se podó nada — cada carpeta bajo la raíz fue recorrida.',
  'map.landed.pruneTruncatedRow':
    'Esta lista está a su vez truncada: {omitted} subárboles podados más están contados en los totales pero no detallados aquí.',
  'map.landed.transcriptTitle': 'La narración, tal como corrió',
  'map.landed.retry': 'Intentar el mapa de nuevo',
  'map.landed.remap': 'Mapear de nuevo',
  'map.landed.failedPartial':
    'Antes de fallar había listado {items} elementos en {folders} carpetas. Ese registro parcial permanece.',
  'map.landed.reviewCta': 'Revisar qué ingerir',
  'map.landed.reviewCtaSub':
    'El mapeo no abrió nada. Elegir qué leer es el siguiente paso — y un consentimiento aparte.',
  'map.ledger.title': 'Lo que sugerimos leer',
  'map.ledger.subtitle':
    'Esto es una recomendación con razones, no un veredicto. Cada resta de abajo está nombrada y contada, así que la diferencia entre lo que el mapa listó y lo que proponemos se puede auditar en lugar de tener que creerla. No se ha abierto nada.',
  'map.ledger.loading': 'Cargando el libro de sugerencias…',
  'map.ledger.loadError':
    'No se pudo cargar el libro de sugerencias ahora mismo. No se ha decidido nada y no se ha leído nada.',
  'map.ledger.loadRetry': 'Intentar de nuevo',
  'map.ledger.noSuggestions':
    'Este mapa no produjo un libro de sugerencias. Las corridas que terminaron antes de que existiera este paso no lo tienen — vuelve a correr el mapa y el libro se construye con él. De cualquier forma, no se abrió nada.',
  'map.ledger.provenance':
    'Política de embudo {policyVersion} · SHA-256 {policySha} · clasificador {classifierVersion} · SHA-256 {classifierSha}',
  'map.ledger.funnelTitle': 'El embudo, con cada resta nombrada',
  'map.ledger.funnelColStage': 'Etapa',
  'map.ledger.funnelColFiles': 'Archivos',
  'map.ledger.funnelColBytes': 'Bytes',
  'map.ledger.funnelColWhy': 'Regla, y por qué',
  'map.ledger.funnelCandidates': 'Candidatos que el mapa listó',
  'map.ledger.funnelDefault': 'Selección predeterminada',
  'map.ledger.funnelArithmetic':
    '{candidateFiles} candidatos − {subtractedFiles} restados = {selectedFiles} seleccionados · {candidateBytes} − {subtractedBytes} = {selectedBytes}.',
  'map.ledger.funnelResidual':
    'Estos renglones no cuadran. {candidateFiles} − {subtractedFiles} deja {expectedFiles}, y la selección registrada es {selectedFiles} — una diferencia de {residualFiles} archivos y {residualBytes}. Los números registrados se muestran tal cual; la discrepancia se dice en voz alta en lugar de esconderse, y nos toca a nosotros corregirla.',
  'map.ledger.zerosIncluded':
    'Las reglas que no quitaron nada aparecen con un cero. Una regla que solo aparece cuando actúa no se puede auditar.',
  'map.ledger.rule.archived_dump_copy': 'copias archivadas de volcados',
  'map.ledger.rule.stub_under_200b': 'archivos de menos de 200 bytes',
  'map.ledger.rule.receipt_shape': 'recibos',
  'map.ledger.rule.machine_output_in_prose': 'salida de máquina disfrazada de prosa',
  'map.ledger.rule.third_party_publication': 'publicaciones de terceros',
  'map.ledger.rule.propagation': 'duplicados de algo ya retirado',
  'map.ledger.rule.duplicate_fingerprint': 'huellas duplicadas',
  'map.ledger.why.archived_dump_copy':
    'Una copia archivada de un árbol de volcado contiene los mismos documentos que ya están en un lugar menos profundo. La evidencia es dónde está, así que esta regla nunca viaja a otras copias.',
  'map.ledger.why.stub_under_200b':
    'Un archivo de menos de 200 bytes no tiene nada que incrustar. El piso es un límite nombrado, y cuántos archivos alcanza queda registrado en cada corrida.',
  'map.ledger.why.receipt_shape':
    'Ruido, no sensibilidad — un recibo de entrega no le enseña nada al sistema. Se excluye porque no lleva conocimiento, explícitamente no porque sea privado.',
  'map.ledger.why.machine_output_in_prose':
    'Una extensión .txt no es autoría. Los volcados de bitácora y las listas de archivos son salida de proceso con ropa de prosa.',
  'map.ledger.why.third_party_publication':
    'Pregunta, no supongas. Los libros descargados, las normas y el material de cursos son referencia que escribió alguien más. Es la única regla cuya exclusión es una pregunta y no un veredicto — volver a agregarlos es exactamente para lo que sirve el paso 12.',
  'map.ledger.why.propagation':
    'Una copia de algo que una regla de alcance documental ya retiró. Un recibo es un recibo en cada carpeta a la que se copió.',
  'map.ledger.why.duplicate_fingerprint':
    'Colapsados por nombre y tamaño exacto, conservando la ruta menos profunda. El tamaño exacto es la mitad honesta de la huella — nada se colapsa solo por el nombre.',
  'map.ledger.why.unknownRule':
    'Esta página todavía no tiene una explicación en lenguaje llano de esa regla — el identificador que aparece al lado es el registro, y viene de la política de embudo nombrada arriba.',
  'map.ledger.sensitiveTitle': 'Formas sensibles — reportadas, no bloqueadas',
  'map.ledger.sensitiveBody':
    'Nada de lo de abajo se quitó por ser sensible. Estados de cuenta, declaraciones de impuestos, nómina, documentos de identidad: están en la selección, porque un sistema al que no puedes darle tus propios registros es una peor búsqueda de tu disco. Estos son conteos de evidencia en los nombres de tu propio disco, no un veredicto sobre lo que hay dentro de los archivos.',
  'map.ledger.sensitiveColShape': 'Forma',
  'map.ledger.sensitiveColCandidates': 'En candidatos',
  'map.ledger.sensitiveColSelected': 'En la selección predeterminada',
  'map.ledger.sensitiveNone': 'Ninguna forma nombrada coincidió con nada de lo que el mapa listó.',
  'map.ledger.sensitiveCountsOnly':
    'Solo conteos, a propósito. Una tabla ordenada de esas rutas en una sola pantalla es un expediente, y esta pantalla no va a construir uno — los renglones de abajo se quedan en orden de ruta y no se pueden ordenar ni filtrar por forma.',
  'map.ledger.shape.bank_statement_shape': 'Con forma de estado de cuenta',
  'map.ledger.shape.credential_shape': 'Con forma de credencial',
  'map.ledger.shape.tax_shape': 'Con forma de impuestos',
  'map.ledger.shape.government_identity_shape': 'Con forma de identificación oficial',
  'map.ledger.shape.legal_shape': 'Con forma de documento legal',
  'map.ledger.shape.insurance_shape': 'Con forma de seguro',
  'map.ledger.shape.pastoral_shape': 'Con forma de tema pastoral',
  'map.ledger.shape.payroll_shape': 'Con forma de nómina',
  'map.ledger.credentialAdvice':
    '{n} archivos aquí parecen secretos vivos — archivos .env, secretos de cliente, notas de credenciales. Copiar uno a un índice de búsqueda es un problema de higiene de llaves, no de privacidad: el secreto sigue siendo válido y ahora existe en un lugar más. Rótalo, no lo excluyas — y luego lee sin restricción. Aquí no se bloquea nada.',
  'map.ledger.sharedTenantNote': '{n} personas pueden entrar a este espacio de trabajo. Todo lo que se lea aquí queda buscable para todas ellas. Eso no dice si la plataforma es segura — dice quién está dentro del perímetro contigo.',
  'map.ledger.tenantShapeUnknown':
    'No pudimos verificar cuántas personas pueden entrar a este espacio de trabajo, así que no podemos decirte quién más podrá buscar lo que se lea. Da por hecho que todos en este espacio pueden.',
  'map.ledger.rowsTitle': 'Cada archivo, con la razón por la que entra o sale',
  'map.ledger.rowsCount': 'Mostrando {shown} de {total} renglones.',
  'map.ledger.rowsMore': 'Cargar la siguiente página',
  'map.ledger.rowsLoadingMore': 'Cargando más renglones…',
  'map.ledger.rowsComplete': 'Esos son todos los renglones del libro.',
  'map.ledger.rowsPageCapNote': 'Una página lleva como máximo {cap} renglones.',
  'map.ledger.rowsCursorInvalid':
    'El servidor no reconoció la posición desde la que pedimos continuar, así que no se cargaron más renglones. Lo de arriba sigue siendo exacto; recarga la página para empezar el listado de nuevo.',
  'map.ledger.rowsPageFailed':
    'No se pudo cargar la siguiente página de renglones. Lo de arriba sigue siendo exacto.',
  'map.ledger.rowsTruncated':
    'El libro mismo se detiene en {cap} renglones — {omitted} archivos más están contados en cada total de arriba pero no aparecen aquí uno por uno. No se puede registrar una decisión contra un libro parcial, así que este disco todavía no se puede decidir, y no se leerá nada.',
  'map.ledger.verdictSelected': 'seleccionado',
  'map.ledger.verdictSubtracted': 'retirado por {rule}',
  'map.ledger.verdictPropagated': 'retirado junto con su duplicado, por {rule}',
  'map.ledger.verdictNotCandidate': 'no es candidato — clasificado como {class}',
  'map.ledger.rankUnranked': 'sin orden de mérito',
  'map.ledger.rankUnrankedCaption':
    'Estos renglones no llevan orden de mérito, y esta lista va en orden de ruta — que no es un ranking de calidad y no se presenta como tal. La razón registrada: {reason}',
  'map.ledger.rankValue': 'lugar {rank}',
  'map.ledger.rankTie': 'empatado en el lugar {rank} con otros {others}',
  'map.ledger.rankArbitrary': 'el orden dentro de este empate es arbitrario',
  'map.ledger.rowShapesLabel': 'formas:',
  'map.ledger.colFile': 'Archivo',
  'map.ledger.colSize': 'Tamaño',
  'map.ledger.colReason': 'Razón',
  'map.ledger.colAction': 'Cámbialo',
  'map.decide.title': 'Quita aquello con lo que no estés de acuerdo',
  'map.decide.body':
    'Quitar algo es un clic. Volver a agregar algo que una regla retiró te pide leer la regla primero — la fricción es deliberadamente asimétrica, porque una eliminación equivocada te cuesta un documento que puedes reponer, y una adición equivocada es una decisión que en realidad nunca tomaste.',
  'map.decide.remove': 'Quitar',
  'map.decide.removedMark': 'Quitado',
  'map.decide.undo': 'Deshacer',
  'map.decide.readdOpen': 'Volver a agregar…',
  'map.decide.readdCancel': 'Déjalo fuera',
  'map.decide.readdConfirm': 'Agrégalo de todos modos',
  'map.decide.readdTitle': 'Volviendo a agregar {name}',
  'map.decide.readdRestated':
    'Este archivo lo retiró la regla «{rule}». {why} Volverlo a agregar anula esa regla solo para este archivo.',
  'map.decide.readdRestatedPropagated':
    'Este archivo se retiró porque una copia con huella idéntica fue retirada por «{rule}». {why} Volverlo a agregar anula eso solo para este archivo; las demás copias no cambian.',
  'map.decide.readdRestatedNotCandidate':
    'Este archivo nunca fue candidato: el clasificador lo registró como {class}, y solo algunas clases se proponen para lectura. Volverlo a agregar anula eso solo para este archivo.',
  'map.decide.readdedMark': 'Agregado de vuelta',
  'map.decide.totalsTitle': 'Tu selección en este momento',
  'map.decide.totalsCounts': '{files} archivos · {bytes}',
  'map.decide.totalsDelta':
    '{removed} quitados y {readded} agregados de vuelta, desde un valor predeterminado de {defaultFiles} archivos.',
  'map.decide.totalsUnchanged': 'Sin cambios respecto a la selección predeterminada.',
  'map.decide.costRange': 'Estimado {low}–{high} tokens.',
  'map.decide.costBinaryShare':
    'El {pct}% de esta selección es PDF y Word, donde el tamaño predice mal el texto — por eso esto es un rango, y lo reconciliamos después de procesarlo.',
  'map.decide.costAllText':
    'Esta selección es toda de formatos de texto plano, donde los bytes predicen bien el texto — aun así es un rango, y lo reconciliamos después de procesarlo.',
  'map.decide.costMethod': 'Cómo se calcula: {method}',
  'map.decide.costDisagreement':
    'Esta página y el servidor no coinciden en el rango de tokens para la selección sin editar, así que se muestran los números del servidor y la aritmética de esta página no se usa para tus cambios. Esa discrepancia es un error nuestro, no un hecho sobre tu disco.',
  'map.decide.costEditedUnavailable':
    'Mientras esa discrepancia siga, no se puede calcular en esta página un rango de tokens para la selección editada. Los totales de archivos y bytes de arriba sí son exactos.',
  'map.decide.save': 'Guardar esta decisión',
  'map.decide.saving': 'Guardando…',
  'map.decide.saved': 'Decisión guardada el {date}.',
  'map.decide.unsaved':
    'Tienes cambios sin guardar. No se lee nada hasta que guardes y después apruebes.',
  'map.decide.continue': 'Continuar — aprobar la lectura',
  'map.decide.saveErrorPathUnknown':
    'El servidor no reconoce {path} en este libro ({field}), así que no se guardó nada. Puede que un mapa más nuevo haya reconstruido el libro — recarga esta página.',
  'map.decide.saveErrorInvalid':
    'El campo {field} que enviamos no era una lista válida de rutas, así que no se guardó nada.',
  'map.decide.saveErrorNoLedger':
    'Ya no hay un libro de sugerencias contra el cual decidir, así que no se guardó nada.',
  'map.decide.saveErrorTruncated':
    'El libro de este disco es más grande de lo que cabe en un registro, así que no se puede registrar una decisión contra él. No se guardó nada, y no se leerá nada.',
  'map.decide.saveErrorConnection': 'Esta conexión ya no existe, así que no se guardó nada.',
  'map.decide.saveFailed': 'La decisión no se guardó. Tus cambios siguen aquí — intenta de nuevo.',
  'ingestConsent.title': 'Abrir y leer los archivos que elegiste.',
  'ingestConsent.honesty':
    'Este es el segundo consentimiento, y es el que abre documentos. Leer nombres nunca fue permiso para leer palabras.',
  'ingestConsent.selectionLine': '{files} archivos · {bytes}, decidido el {date}.',
  'ingestConsent.selectionLineUndated': '{files} archivos · {bytes}.',
  'ingestConsent.costTitle': 'Lo que esto va a costar',
  'ingestConsent.clearanceLabel': 'Clasificación de datos para estos archivos',
  'ingestConsent.clearanceHelp':
    'La clasificación es una decisión sobre lo que hay dentro de estos archivos. El selector de carpeta dejó de preguntarlo a propósito, porque todavía no se había leído nada — ahora el mapa ya te mostró lo que hay aquí, así que este es el momento en el que la pregunta se puede responder con honestidad. Se limita a tu propia autorización, y la puedes cambiar después.',
  'ingestConsent.labelCap': 'La política del operador puede registrar estos archivos con una etiqueta más baja que la que elijas — baja, nunca sube. Si eso ocurre, la etiqueta registrada es la limitada; este es ese límite dicho antes de que actúe, no después.',
  'ingestConsent.clearanceEvidence': 'Lo que el mapa encontró en esta selección, como evidencia para esa decisión:',
  'ingestConsent.cta': 'Abrir y leer {n} archivos',
  'ingestConsent.ctaOne': 'Abrir y leer 1 archivo',
  'ingestConsent.granting': 'Registrando tu consentimiento…',
  'ingestConsent.starting': 'Iniciando la lectura…',
  'ingestConsent.retryStart': 'Iniciar la lectura de nuevo',
  'ingestConsent.alreadyConsented':
    'El consentimiento de lectura ya está registrado para esta conexión — otorgado el {date}. Iniciar una lectura no lo volverá a preguntar; revocar el consentimiento es lo que lo retira.',
  'ingestConsent.staleDisclosure':
    'El texto del consentimiento cambió mientras esta página estaba abierta. No se registró nada y no se leyó nada. La versión actual está abajo — léela antes de continuar.',
  'ingestConsent.connectorsDisabled':
    'Un administrador tiene los conectores apagados para este espacio de trabajo. No se puede leer ningún archivo hasta que los vuelvan a encender.',
  'ingestConsent.consentNotActive':
    'El servidor no tiene un consentimiento de lectura activo para esta conexión — puede que se acabe de revocar. Lee el texto de abajo y vuelve a consentir si aún quieres que se lean los archivos.',
  'ingestConsent.grantFailed':
    'Tu consentimiento no se registró, así que no se inició nada y no se leyó nada. Intenta de nuevo.',
  'ingestConsent.startFailed':
    'Tu consentimiento está registrado. Lo que falló fue iniciar la lectura — inténtalo de nuevo abajo; no se te pedirá consentir dos veces.',
  'ingestConsent.connectionGone':
    'Esta conexión ya no existe. Regresa a conectores y vuelve a conectar un disco.',
  'ingestConsent.noSelection':
    'El servidor no tiene una decisión registrada para esta conexión, así que no hay nada que leer. Regresa al libro y guarda tu decisión — no se leyó nada.',
  'ingestConsent.backToLedger': 'Regresar al libro',
  'map.ingestStarted.title': 'La lectura ya empezó.',
  'map.ingestStarted.body':
    'Se están abriendo y leyendo {files} archivos ahora mismo. Corre en segundo plano — puedes salir de esta página.',
  'map.ingestStarted.workflow': 'Corrida {workflowId}',
  'map.ingestStarted.watch':
    'El avance en vivo está en la pantalla de conectores: archivos leídos contra los {files} que aprobaste, carpeta por carpeta, actualizándose mientras corre.',
  'map.ingestStarted.cta': 'Ver cómo lee tus archivos',
  'connectors.oauthError': 'Conexión fallida: {error}',
  'connectors.provider.onedrive': 'OneDrive',
  'connectors.provider.sharepoint': 'SharePoint',
  'connectors.reading.title': 'Leyendo los archivos de tu {provider}…',
  'connectors.syncing.currentFolder': 'Ahora en {folder}',
  'connectors.syncing.counts': '{folders} carpetas exploradas · {discovered} encontrados · {ingested} leídos · {skipped} omitidos · {deferred} aplazados · {failed} fallidos',
  'connectors.syncing.recentTitle': 'Archivos recién leídos',
  'connectors.syncing.filesIngestedLabel': 'archivos leídos',
  'connectors.syncing.foldersScannedLabel': 'carpetas exploradas',
  'connectors.fileStatus.ingested': 'Ingerido',
  'connectors.fileStatus.skipped': 'Omitido',
  'connectors.fileStatus.failed': 'Fallido',
  'connectors.complete.title': 'Sincronización completa',
  'connectors.complete.summary': '{ingested} de {discovered} archivos ingeridos',
  'connectors.complete.withFailures': ', {failed} fallidos',
  'connectors.complete.titlePartial': 'Sincronización finalizada con errores',
  'connectors.complete.ctaSubtitlePartial': 'Chatea y busca en los {ingested} archivos que se incorporaron. {failed} no se pudieron leer y NO se pueden buscar.',
  'connectors.complete.partialHint': 'Esta carpeta solo se puede buscar parcialmente. "Reintentar archivos fallidos" reintenta solo los errores.',
  'connectors.complete.duration': 'en {duration}',
  'connectors.complete.ctaSubtitle': 'Chatea y busca en todo lo ingerido desde {folder}',
  'connectors.complete.cta': 'Empezar a trabajar con estos archivos',
  'connectors.complete.emptySummary': 'No se encontraron archivos tras explorar {folders} carpetas',
  'connectors.complete.emptySummaryNoFolders': 'Esta carpeta está vacía',
  'connectors.complete.emptyHint': 'Prueba con otra carpeta raíz usando "Cambiar carpeta" abajo.',
  'connectors.failed.title': 'Sincronización fallida',
  'connectors.failed.hint': 'Reintentar solo vuelve a procesar los archivos fallidos, no toda la sincronización.',
  'connectors.retryFailed': 'Reintentar archivos fallidos',
  'connectors.fileStatus.deferred': 'Aplazado',
  'connectors.fileStatus.unknown': 'Estado desconocido',
  'connectors.ingest.title': 'Leyendo los archivos que aprobaste',
  'connectors.ingest.readLabel': 'archivos leídos',
  'connectors.ingest.selectedLabel': 'aprobaste',
  'connectors.ingest.currentFile': 'Leyendo {path}',
  'connectors.ingest.currentFileNone': 'Abriendo el primer archivo…',
  'connectors.ingest.progress': '{done} de {selected} archivos · {pct}%',
  'connectors.ingest.progressStale':
    '{done} archivos procesados, más que los {selected} que aprobaste — el total aprobado quedó desactualizado para esta corrida, así que no se muestra porcentaje. Los conteos siguen siendo exactos.',
  'connectors.ingest.progressNoDenominator':
    '{done} archivos procesados. Esta corrida no registró cuántos aprobaste, así que no hay porcentaje que mostrar — solo una barra dibujada contra un total real significaría algo.',
  'connectors.ingest.nRead': '{n} leídos',
  'connectors.ingest.nFailed': '{n} fallidos',
  'connectors.ingest.nDeferred': '{n} aplazados',
  'connectors.ingest.nSkipped': '{n} omitidos',
  'connectors.ingest.foldersTitle': 'Por carpeta',
  'connectors.ingest.folderRow': '{ingested} de {selected} leídos',
  'connectors.ingest.foldersShown': 'Mostrando {shown} de {total} carpetas, primero las que necesitan atención.',
  'connectors.ingest.foldersOmitted':
    'Otras {omitted} carpetas no se detallaron en esta corrida. Sus archivos sí están contados en los totales de arriba.',
  'connectors.ingest.failuresNotItemized':
    'Cuáles archivos fallaron queda registrado en la corrida misma; esta pantalla puede mostrar las causas, pero todavía no la lista de archivos.',
  'connectors.ingest.failuresOmitted': '{omitted} de los fallos no se detallaron ni siquiera ahí.',
  'connectors.ingest.runLabel': 'Corrida {runId}',
  'connectors.ingest.completeTitle': 'Se leyó cada archivo aprobado',
  'connectors.ingest.completeTitleWithSkips': 'Leído — con algunos archivos omitidos',
  'connectors.ingest.completeSummary': '{ingested} de los {selected} archivos que aprobaste ya se pueden buscar.',
  'connectors.ingest.completeSummaryNoDenominator': '{ingested} archivos ya se pueden buscar.',
  'connectors.ingest.partialTitle': 'Terminó con fallos',
  'connectors.ingest.partialSummary':
    '{ingested} archivos se pueden buscar. {failed} no se pudieron leer y NO se pueden buscar.',
  'connectors.ingest.deferredTitle': 'Aplazado — el destino declinó el resto por ahora',
  'connectors.ingest.deferredSummary': '{ingested} archivos se pueden buscar. {deferred} quedaron aplazados — no se perdió nada y nada falló.',
  'connectors.ingest.nothingReadTitle': 'Nada quedó disponible para búsqueda',
  'connectors.ingest.nothingReadSummary':
    'Los {done} archivos se omitieron sin abrirse. Nada de esta corrida se puede buscar.',
  'connectors.ingest.nothingDoneTitle': 'No se leyó nada',
  'connectors.ingest.nothingDoneSelected':
    'Aprobaste {selected} archivos y esta corrida no procesó ninguno. No se abrió nada y no se cambió nada.',
  'connectors.ingest.nothingDoneEmptySelection':
    'Esta corrida terminó con una selección vacía — no se aprobó ningún archivo, así que no se abrió ninguno.',
  'connectors.ingest.failedTitle': 'La lectura se detuvo antes de tiempo',
  'connectors.ingest.failedSummary':
    'Esta corrida se detuvo antes de terminar. {ingested} archivos alcanzaron a leerse y se pueden buscar; el resto no.',
  'connectors.ingest.refusedNoConsentTitle': 'La lectura fue rechazada',
  'connectors.ingest.refusedNoConsent':
    'No había un consentimiento activo para leer el contenido de los archivos cuando empezó esta corrida, así que no se abrió nada. Revisa la selección para otorgarlo de nuevo.',
  'connectors.ingest.refusedUnsupportedTitle': 'Esta unidad no se puede leer',
  'connectors.ingest.refusedUnsupported':
    'El proveedor de esta conexión no tiene lector en esta plataforma, así que no se abrió nada. No se usó ningún consentimiento.',
  'connectors.ingest.unrecognizedTitle': 'Esta corrida reportó un estado que esta pantalla no conoce',
  'connectors.ingest.unrecognizedBody':
    'La corrida reportó «{status}». Esta página es más antigua que el servicio que lo escribió, así que no va a adivinar qué significa. Los conteos de abajo son exactamente lo que la corrida registró.',
  'connectors.ingest.cta': 'Empezar a trabajar con estos archivos',
  'connectors.ingest.reviewCta': 'Revisar la selección y leer de nuevo',
  'connectors.cause.title': 'Por qué no se leyeron algunos archivos',
  'connectors.cause.failed': 'Se abrieron, pero no se pudieron leer',
  'connectors.cause.failedAdvice':
    'Estos archivos sí se descargaron y el lector no pudo extraerles texto. Volver a leerlos puede funcionar si la causa fue temporal; cada documento guarda su propia razón registrada.',
  'connectors.cause.deferred': 'Aplazado — el destino de ingesta lo declinó por ahora',
  'connectors.cause.deferredAdvice': 'No son fallos y no se pierde nada. El destino de ingesta los declinó por ahora — cuota, presupuesto o contrapresión de su lado — y el pase de reintento los vuelve a enviar solo cuando acepte de nuevo. Volver a leer a mano no lo acelera.',
  'connectors.cause.alreadyIngested': 'Ya se habían leído en una corrida anterior',
  'connectors.cause.alreadyIngestedAdvice':
    'Ya estaban en tu acervo, así que no se leyeron ni se cobraron dos veces. Se pueden buscar ahora. No hay nada que hacer.',
  'connectors.cause.tooLarge': 'Más grandes que el límite de tamaño',
  'connectors.cause.tooLargeAdvice':
    'Nunca se descargaron ni se abrieron, así que no gastaron nada. Divide el archivo, o sube directamente la parte que necesitas, y sí se leerá.',
  'connectors.cause.unsupportedType': 'No es un tipo de archivo que el lector abra',
  'connectors.cause.unsupportedTypeAdvice':
    'Nunca se descargaron. Guárdalo como PDF, DOCX o texto plano y sí se leerá. Volver a leer tal cual lo volverá a omitir.',
  'connectors.cause.unnamed': 'Omitidos sin razón registrada',
  'connectors.cause.unnamedAdvice':
    'La corrida los omitió sin decir por qué. Eso es un hueco en nuestro registro, no algo que puedas arreglar — avísanos y lo investigamos.',
  'connectors.cause.recoveryNone': 'Nada que hacer',
  'connectors.cause.recoveryAutomatic': 'Se recupera solo',
  'connectors.cause.recoveryCustomer': 'Esto sí lo puedes arreglar',
  'connectors.cause.recoveryRetry': 'Volver a leer puede ayudar',
  'connectors.cause.recoveryUnknown': 'Causa no registrada',
  'connectors.complete.titleDeferred': 'Aplazado — el resto quedó estacionado, no fallido',
  'connectors.complete.deferredHint': '{deferred} archivos quedaron estacionados, no fallidos. El destino de ingesta los declinó por ahora; terminan solos cuando los acepte.',
  'connectors.complete.emptyWithFailures':
    'No se encontraron archivos en esta carpeta, y {failed} archivos que venían de la corrida anterior volvieron a fallar. Siguen sin poder buscarse.',
  'connectors.sync.deltaReenumerated':
    'El marcador de cambios guardado para esta unidad había expirado, así que esta corrida recorrió toda la carpeta otra vez ({n}×). No se leyó nada dos veces.',
  'connectors.browse.serverTruncated': 'El servidor dejó de listar al llegar a su propio tope — esta lista NO está completa. Carga el resto para continuar donde se detuvo.',
};
