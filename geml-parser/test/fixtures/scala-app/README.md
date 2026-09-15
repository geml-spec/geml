# scala-app — SCIP fixture (Scala via scip-java 0.12.3)

Four Scala 3 files exercising what the codemap `scip` adapter must read from
the `semanticdb` symbol scheme: a trait with two implementations (dispatch
candidates), two overloads of one method (`(+1)` disambiguator), a companion
`apply`, a cross-file call, and `new X(...)` (invisible in Scala 3
SemanticDB — a pinned known gap).

`index.scip` is PRE-BAKED and committed. It was produced with the **last**
scip-java that still indexed Scala — 0.13 (2026-07) dropped Scala — so the
recipe is frozen on purpose:

```sh
# 1. compile with SemanticDB (scala-maven-plugin, -Xsemanticdb); pom below
mvn -B compile
# 2. SemanticDB -> SCIP, run IN this directory (the sourceroot is the cwd)
java -cp "<classpath of com.sourcegraph:scip-java_2.13:0.12.3>"   com.sourcegraph.scip_java.ScipJava index-semanticdb --output index.scip target/classes
rm -rf target
```

The classpath comes from Maven: a throwaway pom depending on
`com.sourcegraph:scip-java_2.13:0.12.3` and
`mvn dependency:build-classpath -Dmdep.outputFile=cp.txt`. (The GitHub release
`v0.12.3` also ships a launcher plus a `.bat`.)

The build `pom.xml` is kept here rather than as a file: a real `pom.xml` under
the fixture would make language auto-detection read the WHOLE geml repo as a
Java/Maven project and demand Joern.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId>
  <artifactId>smoke-scala</artifactId>
  <version>0.1.0</version>
  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <scala.version>3.3.8</scala.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.scala-lang</groupId>
      <artifactId>scala3-library_3</artifactId>
      <version>${scala.version}</version>
    </dependency>
  </dependencies>
  <build>
    <sourceDirectory>src/main/scala</sourceDirectory>
    <plugins>
      <plugin>
        <groupId>net.alchim31.maven</groupId>
        <artifactId>scala-maven-plugin</artifactId>
        <version>4.9.10</version>
        <executions>
          <execution>
            <goals><goal>compile</goal></goals>
          </execution>
        </executions>
        <configuration>
          <scalaVersion>${scala.version}</scalaVersion>
          <recompileMode>all</recompileMode>
          <args>
            <arg>-Xsemanticdb</arg>
            <arg>-sourceroot</arg>
            <arg>${project.basedir}</arg>
          </args>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```
