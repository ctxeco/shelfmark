# Qué lee ctxEco cuando mapea sus carpetas

Está por autorizar que ctxEco **mapee** una parte de su almacenamiento en la
nube. Mapear consiste en leer la estructura de sus carpetas y los datos que su
sistema de almacenamiento ya guarda sobre cada elemento. No abre sus documentos.

Léalo antes de aceptar. Guardamos el texto exacto de esta página junto con su
decisión, para que después no quede duda de lo que se le informó.

## Qué leemos

De cada carpeta y cada archivo dentro del área que usted elija, incluido todo lo
que esté anidado adentro:

- el **nombre** del archivo o de la carpeta
- su **ruta completa**: el nombre de cada carpeta del camino hasta él
- su **tamaño** y su **tipo de archivo**
- las **fechas** de creación y de última modificación
- quién es su **propietario** y quién lo **creó**
- quién lo **modificó por última vez**
- la **estructura de permisos y de uso compartido** a su alrededor: qué
  personas, grupos, aplicaciones, dominios y enlaces para compartir tienen
  acceso concedido, y con qué rol
- los identificadores que su sistema de almacenamiento usa para el elemento,
  para la unidad donde está y para el sitio al que pertenece

## Qué no leemos

No abrimos, no descargamos ni leemos el contenido de ningún documento. Ni el
texto, ni las imágenes que contenga, ni una vista previa, ni una miniatura, ni
un resumen extraído. No se descarga nada del interior de un archivo y no se
indexa nada del interior de un archivo.

Leer el contenido es otra cosa. Se llama ingesta, tiene su propio aviso y
requiere su consentimiento por separado.

## Esto no es una función de privacidad

Queremos ser francos en esto, porque la afirmación contraria es la fácil de
hacer y no la vamos a hacer.

Los nombres y las rutas no son inofensivos. Una sola ruta puede decir más que el
documento al que apunta:

    /Jurídico/Litigios/Smith vs Acme/Borrador de convenio.docx

Nadie abrió ese archivo y usted ya sabe que hay un litigio, contra quién, a qué
parte se está asesorando y que se está redactando un convenio. Una carpeta
llamada `Oncología`, o un archivo llamado
`Evaluación de desempeño - <nombre> 2025.docx`, funcionan igual. Las rutas las
escriben personas para que signifiquen algo, y eso las vuelve casi puro dato
revelador, sin relleno.

Así que la afirmación honesta no es que esto sea inofensivo por tratarse solo de
metadatos. La afirmación honesta es: **leemos menos, y le decimos con precisión
qué leemos.**

## La estructura de uso compartido también es información

Quién tiene acceso a qué dice algo por sí mismo. Un mapa muestra qué personas
trabajan sobre el mismo material, qué dominios externos fueron admitidos y dónde
un enlace abierto está exponiendo una carpeta. Encontrar esto último suele ser
la razón misma para construir un mapa, pero conviene decirlo con claridad: un
mapa del uso compartido es también un mapa de quién trabaja con quién, y quizá
usted no esperaba que una herramienta de archivos dedujera eso.

## Quién puede ver el mapa después

La conexión se hace con su cuenta, así que ctxEco solo puede leer lo que usted
ya puede ver en su almacenamiento. Eso limita lo que se lee. **No limita, por sí
solo, quién puede verlo después.**

El mapa pasa a formar parte de su espacio de trabajo en ctxEco. Otras personas
de ese espacio podrían alcanzar lo que contiene —nombres de carpetas, rutas,
quién trabajó en qué— mediante búsquedas y respuestas, aunque no pudieran abrir
la carpeta original en su almacenamiento. Usted puede acotarlo con los controles
de acceso de su propio espacio de trabajo, pero de origen no está acotado. Por
favor no mapee un área que no estaría dispuesto a describirle a sus colegas.

## Usar el mapa implica enviar partes de él a un servicio de inferencia

El mapa se guarda en su espacio de trabajo de ctxEco. Pero cuando se usa para
responder una pregunta, las partes que responden esa pregunta —nombres de
carpetas, rutas, los nombres de las personas que trabajaron en algo— se envían
al servicio de inferencia configurado para su espacio de trabajo, igual que se
enviaría el texto de un documento. La configuración de su espacio de trabajo
determina cuál es ese servicio y dónde se ejecuta.

Lo decimos aquí, y no solo en el aviso sobre la lectura del contenido de los
documentos, porque una ruta suele revelar más que el documento al que apunta.
«Son solo metadatos» no es una razón para informar esto con menos cuidado.

## En sus carpetas puede haber archivos de otras personas

Las unidades personales y las compartidas casi siempre contienen material que
otras personas le enviaron, o que es de otras personas, o que pertenece a un
cliente. Elegir un área para mapear es una decisión sobre los nombres y el orden
de esas personas, no solo sobre los suyos, y con frecuencia no le corresponde
tomarla a usted solo. Elija el área más acotada que de verdad le sirva.

## Qué cubre este permiso

Únicamente el área indicada en este registro de consentimiento, y todo lo que
esté anidado dentro de ella. Todo lo que figure aquí como exclusión no se mapea.
Este permiso no se extiende a ningún otro sitio, unidad ni carpeta: cada uno de
esos requiere su propio consentimiento y su propio registro.

## Nunca modificamos nada en su almacenamiento

Mapear es de solo lectura. ctxEco no crea, no renombra, no mueve, no sobrescribe
ni elimina nada en su almacenamiento mientras mapea. Nunca elimina un archivo
suyo: ni en esta función, ni en ninguna otra parte de este producto, bajo
ninguna configuración.

## Cómo revocar este permiso

Puede revocar este permiso cuando lo desee, desde la configuración de sus
conectores.

La revocación se registra como un **evento nuevo e independiente**. El registro
de su decisión original nunca se modifica ni se elimina, de modo que el
historial de qué se permitió, quién lo permitió y cuándo queda íntegro y puede
examinarse después. No mapeamos con un permiso que ha sido revocado.

**Revocar no borra por sí solo el mapa que ya se construyó.** Lo decimos con
todas sus letras porque la versión cómoda de esta frase no sería cierta.
Eliminar un mapa que ya existe es una acción aparte; revocar su permiso no es
esa acción y no la ejecuta. Si quiere que se elimine un mapa, pídanoslo y lo
eliminamos.

Nada de esto toca su almacenamiento. Otorgar este permiso, revocarlo y eliminar
después un mapa dejan sus carpetas y sus archivos exactamente como están.

## Qué no hacemos con esto

No lo vendemos. No lo compartimos con otros clientes de ctxEco: su espacio de
trabajo está aislado de todos los demás. Ni ctxEco ni los proveedores de modelos
que ctxEco utiliza entrenan modelos con esto.
