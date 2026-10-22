\set k random(1, 50)
select bench.bid(:client_id + 1, :k);
