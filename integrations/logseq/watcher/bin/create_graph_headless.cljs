(ns create-graph-headless
  "Create an empty Logseq DB graph without the desktop app: the CLI package
   vendors the whole logseq.db stack, and open-db! creates tables on open.
   This does exactly what the app's create-graph does at the db level:
   mkdir + open + transact build-db-initial-data.

   open-db! creates the DATABASE but refuses a missing DIRECTORY (its error
   says only 'Cannot open database because the directory does not exist'),
   so the mkdir here is load-bearing."
  (:require [logseq.db.common.sqlite-cli :as sqlite-cli]
            [logseq.db.sqlite.create-graph :as sqlite-create-graph]
            [datascript.core :as d]
            ["fs" :as fs]
            ["os" :as os]
            ["path" :as node-path]))

(def graph-name (or (aget (.-env js/process) "GEML_GRAPH_NAME") "geml-spike"))
(def graphs-dir (node-path/join (os/homedir) "logseq" "graphs"))
(fs/mkdirSync (node-path/join graphs-dir graph-name) #js {:recursive true})
(def conn (sqlite-cli/open-db! graphs-dir graph-name))
(d/transact! conn (sqlite-create-graph/build-db-initial-data "{}"))
(println "created" (node-path/join graphs-dir graph-name))
